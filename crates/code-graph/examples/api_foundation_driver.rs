use demlik_code_graph::{
    api::{
        diff::diff_subpath_names,
        map::{self, ApiError, ApiSchemaError},
        model::{
            AddedName, ApiChange, ApiDiff, ApiEntryText, ApiRatchetMiss, ApiRatchetVerdict,
            ApiReferences, Bump, BumpPolicy, BumpRule, ChangeKind, ChangedName, Changeset,
            ChangesetBump, ChangesetsSince, RemovedName, SubpathDiff, SubpathNames, VerdictContext,
        },
        ratchet::{policy, text::render_api_ratchet, verdict},
    },
    render::json::stable_stringify,
    text::{JsString, JsValue, object_keys},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    sync::Arc,
};
#[path = "support/number_input.rs"]
mod number_input;
use number_input::JsNumberInput;
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    text: JsString,
    references: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PoolInput {
    references: Vec<Vec<(JsString, JsString)>>,
    entries: Vec<Entry>,
}
struct Pool {
    references: Vec<Arc<ApiReferences>>,
    entries: Vec<Arc<ApiEntryText>>,
}
impl PoolInput {
    fn build(self) -> Result<Pool, String> {
        let references = self
            .references
            .into_iter()
            .map(|rows| Arc::new(rows.into_iter().collect()))
            .collect::<Vec<_>>();
        let entries = self
            .entries
            .into_iter()
            .map(|entry| {
                Ok(Arc::new(ApiEntryText {
                    text: entry.text,
                    references: Arc::clone(
                        references
                            .get(entry.references)
                            .ok_or("reference index outside pool")?,
                    ),
                }))
            })
            .collect::<Result<_, String>>()?;
        Ok(Pool {
            references,
            entries,
        })
    }
}
impl Pool {
    fn entry(&self, index: usize) -> Result<Arc<ApiEntryText>, String> {
        self.entries
            .get(index)
            .map(Arc::clone)
            .ok_or("entry index outside pool".into())
    }
    fn names(&self, names: Vec<(JsString, usize)>) -> Result<SubpathNames, String> {
        names
            .into_iter()
            .map(|(name, index)| Ok((name, self.entry(index)?)))
            .collect()
    }
    fn identity(&self, entry: &Arc<ApiEntryText>) -> Identity {
        Identity {
            entry: self
                .entries
                .iter()
                .position(|candidate| Arc::ptr_eq(candidate, entry)),
            references: self
                .references
                .iter()
                .position(|candidate| Arc::ptr_eq(candidate, &entry.references)),
        }
    }
}
#[derive(Serialize)]
struct Identity {
    entry: Option<usize>,
    references: Option<usize>,
}
#[derive(Serialize)]
struct ChangeIdentity<'a> {
    subpath: &'a JsString,
    name: &'a JsString,
    kind: ChangeKind,
    before: Option<Identity>,
    after: Option<Identity>,
}
fn change_identities<'a>(
    pool: &Pool,
    changes: impl IntoIterator<Item = &'a ApiChange>,
) -> Vec<ChangeIdentity<'a>> {
    changes
        .into_iter()
        .map(|change| ChangeIdentity {
            subpath: &change.subpath,
            name: &change.name,
            kind: change.kind,
            before: change.before.as_ref().map(|entry| pool.identity(entry)),
            after: change.after.as_ref().map(|entry| pool.identity(entry)),
        })
        .collect()
}
#[derive(Serialize)]
struct PairIdentity {
    before: Option<Identity>,
    after: Option<Identity>,
}
#[derive(Serialize)]
struct PrototypeIdentity {
    added: Option<PairIdentity>,
    changed: Option<PairIdentity>,
    removed: Option<PairIdentity>,
}
fn prototypes(pool: &Pool, diff: &SubpathDiff) -> PrototypeIdentity {
    PrototypeIdentity {
        added: diff.added_prototype().map(|value| PairIdentity {
            before: None,
            after: Some(pool.identity(&value.after)),
        }),
        changed: diff.changed_prototype().map(|value| PairIdentity {
            before: Some(pool.identity(&value.before)),
            after: Some(pool.identity(&value.after)),
        }),
        removed: diff.removed_prototype().map(|value| PairIdentity {
            before: Some(pool.identity(&value.before)),
            after: None,
        }),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubpathInput {
    subpath: JsString,
    #[serde(deserialize_with = "required_option")]
    tier: Option<JsString>,
    added: Vec<(JsString, usize)>,
    removed: Vec<(JsString, usize)>,
    changed: Vec<(JsString, usize, usize)>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiffInput {
    root: JsString,
    base: JsString,
    compiler: JsString,
    subpaths: Vec<SubpathInput>,
}
impl DiffInput {
    fn build(self, pool: &Pool) -> Result<ApiDiff, String> {
        let mut subpaths = indexmap::IndexMap::new();
        for item in self.subpaths {
            let mut diff = SubpathDiff::new(item.tier);
            for (name, index) in item.added {
                diff.added.insert(
                    name,
                    AddedName {
                        after: pool.entry(index)?,
                    },
                );
            }
            for (name, index) in item.removed {
                diff.removed.insert(
                    name,
                    RemovedName {
                        before: pool.entry(index)?,
                    },
                );
            }
            for (name, before, after) in item.changed {
                diff.changed.insert(
                    name,
                    ChangedName {
                        before: pool.entry(before)?,
                        after: pool.entry(after)?,
                    },
                );
            }
            subpaths.insert(item.subpath, diff);
        }
        Ok(ApiDiff {
            root: self.root,
            base: self.base,
            compiler: self.compiler,
            subpaths,
        })
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CountedInput {
    file: JsString,
    bump: ChangesetBump,
    body: JsString,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangesetsInput {
    package: JsString,
    changesets: Vec<CountedInput>,
}
impl From<ChangesetsInput> for ChangesetsSince {
    fn from(value: ChangesetsInput) -> Self {
        Self {
            package: value.package,
            changesets: value
                .changesets
                .into_iter()
                .map(|value| Changeset {
                    file: value.file,
                    bump: value.bump,
                    body: value.body,
                })
                .collect(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextInput {
    changes: JsNumberInput,
    callout: JsString,
}
impl From<ContextInput> for VerdictContext {
    fn from(value: ContextInput) -> Self {
        Self {
            changes: value.changes.value(),
            callout: value.callout,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleInput {
    bump: Bump,
    callout: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MissInput {
    subpath: JsString,
    #[serde(deserialize_with = "required_option")]
    tier: Option<JsString>,
    name: JsString,
    kind: ChangeKind,
    #[serde(deserialize_with = "required_option")]
    before: Option<usize>,
    #[serde(deserialize_with = "required_option")]
    after: Option<usize>,
    needs: RuleInput,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerdictInput {
    passed: bool,
    base: JsString,
    package: JsString,
    changesets: Vec<JsString>,
    highest_bump: Bump,
    callout_found: bool,
    misses: Vec<MissInput>,
}
impl VerdictInput {
    fn build(self, pool: &Pool) -> Result<ApiRatchetVerdict, String> {
        let misses = self
            .misses
            .into_iter()
            .map(|miss| {
                Ok(ApiRatchetMiss {
                    change: ApiChange {
                        subpath: miss.subpath,
                        tier: miss.tier,
                        name: miss.name,
                        kind: miss.kind,
                        before: miss.before.map(|index| pool.entry(index)).transpose()?,
                        after: miss.after.map(|index| pool.entry(index)).transpose()?,
                    },
                    needs: Arc::new(BumpRule {
                        bump: miss.needs.bump,
                        callout: miss.needs.callout,
                    }),
                })
            })
            .collect::<Result<_, String>>()?;
        Ok(ApiRatchetVerdict {
            passed: self.passed,
            base: self.base,
            package: self.package,
            changesets: self.changesets,
            highest_bump: self.highest_bump,
            callout_found: self.callout_found,
            misses,
        })
    }
}
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
fn value(item: &impl Serialize) -> Result<JsValue, String> {
    JsValue::parse(&serde_json::to_string(item).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn obj(rows: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    JsValue::Object(
        rows.into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn checked<T: Serialize>(parsed: Result<T, ApiSchemaError>) -> Result<JsValue, String> {
    Ok(match parsed {
        Ok(data) => obj([("success", JsValue::Bool(true)), ("data", value(&data)?)]),
        Err(ApiSchemaError::Issues(issues)) => obj([
            ("success", JsValue::Bool(false)),
            ("issues", value(&issues)?),
        ]),
        Err(ApiSchemaError::TypeError(thrown)) => obj([("thrown", value(&thrown)?)]),
    })
}
fn refused(error: ApiError) -> Result<JsValue, String> {
    let thrown = match error {
        ApiError::Input(error) => obj([
            ("name", JsValue::String(error.name().into())),
            ("message", JsValue::String(error.message().clone())),
        ]),
        ApiError::TypeError(error) => value(&error)?,
        ApiError::Io { path, source } => obj([
            ("name", JsValue::String("IoError".into())),
            ("path", JsValue::String(path)),
            ("message", JsValue::String(source.to_string().into())),
        ]),
    };
    Ok(obj([("thrown", thrown)]))
}
fn fields(value: &JsValue, allowed: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("expected input object")?;
    if object
        .keys()
        .any(|key| !allowed.iter().any(|allowed| key == *allowed))
    {
        return Err("unexpected input field".into());
    }
    Ok(())
}
fn field<'a>(value: &'a JsValue, key: &str) -> Result<&'a JsValue, String> {
    value.get(key).ok_or(format!("missing field {key}"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &JsValue) -> Result<T, String> {
    serde_json::from_str(&serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<JsValue, String> {
    if request.operation != "code_graph.api-foundation" {
        return Err("unsupported operation".into());
    }
    let input = JsValue::parse(request.input.get()).map_err(|error| error.to_string())?;
    let action: String = decode(field(&input, "action")?)?;
    match action.as_str() {
        "parse-map" => {
            fields(&input, &["action", "value"])?;
            checked(observe!(calls, map::parse_api_map, field(&input, "value")?))
        }
        "parse-policy" => {
            fields(&input, &["action", "value"])?;
            checked(observe!(calls, BumpPolicy::parse, field(&input, "value")?))
        }
        "policy" => {
            fields(&input, &["action", "value"])?;
            match observe!(calls, policy::bump_policy, field(&input, "value")?) {
                Ok(policy) => value(&policy),
                Err(error) => refused(error),
            }
        }
        "subpaths" => {
            fields(&input, &["action", "root", "map", "base"])?;
            let root: JsString = decode(field(&input, "root")?)?;
            let map = field(&input, "map")?;
            let base: Option<JsString> = decode(field(&input, "base")?)?;
            let result = match base {
                Some(base) => observe!(calls, map::base_api_subpaths, &root, map, &base),
                None => observe!(calls, map::api_subpaths, &root, map),
            };
            match result {
                Ok(rows) => value(&rows),
                Err(error) => refused(error),
            }
        }
        "diff" => {
            fields(&input, &["action", "pool", "tier", "before", "after"])?;
            let pool = decode::<PoolInput>(field(&input, "pool")?)?.build()?;
            let tier: Option<JsString> = decode(field(&input, "tier")?)?;
            let before = pool.names(decode(field(&input, "before")?)?)?;
            let after = pool.names(decode(field(&input, "after")?)?)?;
            let diff = observe!(calls, diff_subpath_names, tier.as_ref(), &before, &after);
            let prototypes = value(&prototypes(&pool, &diff))?;
            let keys = value(&[
                object_keys(&diff.added),
                object_keys(&diff.changed),
                object_keys(&diff.removed),
            ])?;
            let snapshot = value(&diff)?;
            let api = ApiDiff {
                root: "root".into(),
                base: "base".into(),
                compiler: "compiler".into(),
                subpaths: [(".".into(), diff)].into_iter().collect(),
            };
            let changes = observe!(calls, verdict::api_changes, &api);
            Ok(obj([
                ("diff", snapshot),
                ("keys", keys),
                ("prototypes", prototypes),
                ("changes", value(&changes)?),
                ("identities", value(&change_identities(&pool, &changes))?),
            ]))
        }
        "changes" | "ratchet" => {
            let allowed = if action == "changes" {
                vec!["action", "pool", "diff"]
            } else {
                vec!["action", "pool", "diff", "policy", "changesets", "context"]
            };
            fields(&input, &allowed)?;
            let pool = decode::<PoolInput>(field(&input, "pool")?)?.build()?;
            let diff = decode::<DiffInput>(field(&input, "diff")?)?.build(&pool)?;
            if action == "changes" {
                let changes = observe!(calls, verdict::api_changes, &diff);
                return Ok(obj([
                    ("changes", value(&changes)?),
                    ("identities", value(&change_identities(&pool, &changes))?),
                ]));
            }
            let changesets: ChangesetsSince =
                decode::<ChangesetsInput>(field(&input, "changesets")?)?.into();
            let context: VerdictContext = decode::<ContextInput>(field(&input, "context")?)?.into();
            let snapshot = serde_json::to_string(&diff).map_err(|error| error.to_string())?;
            match observe!(
                calls,
                verdict::ratchet_api_diff,
                &diff,
                field(&input, "policy")?,
                &changesets
            ) {
                Err(error) => refused(error),
                Ok(verdict) => {
                    let text = observe!(calls, render_api_ratchet, &verdict, &context);
                    let rules_shared = verdict
                        .misses
                        .iter()
                        .map(|left| {
                            verdict
                                .misses
                                .iter()
                                .map(|right| Arc::ptr_eq(&left.needs, &right.needs))
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>();
                    Ok(obj([
                        ("verdict", value(&verdict)?),
                        ("text", JsValue::String(text)),
                        (
                            "identities",
                            value(&change_identities(
                                &pool,
                                verdict.misses.iter().map(|miss| &miss.change),
                            ))?,
                        ),
                        ("rulesShared", value(&rules_shared)?),
                        (
                            "diffUnchanged",
                            JsValue::Bool(
                                snapshot
                                    == serde_json::to_string(&diff)
                                        .map_err(|error| error.to_string())?,
                            ),
                        ),
                    ]))
                }
            }
        }
        "render" => {
            fields(&input, &["action", "pool", "verdict", "context"])?;
            let pool = decode::<PoolInput>(field(&input, "pool")?)?.build()?;
            let verdict = decode::<VerdictInput>(field(&input, "verdict")?)?.build(&pool)?;
            let context: VerdictContext = decode::<ContextInput>(field(&input, "context")?)?.into();
            let text = observe!(calls, render_api_ratchet, &verdict, &context);
            let compact = observe!(calls, stable_stringify, &verdict, false)
                .map_err(|error| error.to_string())?;
            let pretty = observe!(calls, stable_stringify, &verdict, true)
                .map_err(|error| error.to_string())?;
            Ok(obj([
                ("text", JsValue::String(text)),
                ("compact", JsValue::String(compact.into())),
                ("pretty", JsValue::String(pretty.into())),
            ]))
        }
        _ => Err("unknown action".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut calls = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut calls));
        #[derive(Serialize)]
        struct Error {
            tag: &'static str,
            message: String,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<JsValue>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<Error>,
            observed_calls: Vec<&'static str>,
        }
        let (output, error) = match result {
            Ok(output) => (Some(output), None),
            Err(message) => (
                None,
                Some(Error {
                    tag: "driver-error",
                    message,
                }),
            ),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok: output.is_some(),
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
