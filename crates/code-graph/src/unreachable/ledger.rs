use crate::{
    config::issue_location,
    project::{Collation, CollationError, CollationInput},
    schema::{UnreachableCategory, UnreachableSymbol},
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, nonempty_string},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{cmp::Ordering, fs, io, sync::Arc};

pub const UNREACHABLE_LEDGER_FILENAME: &str = "unreachable-ledger.json";
#[derive(Debug, Serialize)]
pub struct UnreachableFinding {
    pub scope: JsString,
    pub kind: UnreachableCategory,
    pub id: JsString,
}
#[derive(Debug, Serialize)]
pub struct UnreachableLedgerEntry {
    #[serde(flatten)]
    pub finding: UnreachableFinding,
    pub reason: JsString,
}
#[derive(Debug, Default, Serialize)]
pub struct UnreachableLedger {
    pub entries: Vec<Arc<UnreachableLedgerEntry>>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UnreachableLedgerRead {
    Absent,
    Read {
        ledger: UnreachableLedger,
    },
    Invalid {
        message: JsString,
        #[serde(skip)]
        source: Option<io::Error>,
    },
}
pub fn finding_key(finding: &UnreachableFinding) -> String {
    serde_json::to_string(&(&finding.scope, &finding.kind, &finding.id))
        .expect("finding identities contain encodable strings")
}
struct FindingInput {
    scope: CollationInput,
    kind: CollationInput,
    id: CollationInput,
}
impl FindingInput {
    fn new(finding: &UnreachableFinding) -> Result<Self, CollationError> {
        Ok(Self {
            scope: CollationInput::from_utf16(finding.scope.units())?,
            kind: CollationInput::from_text(finding.kind.as_str())?,
            id: CollationInput::from_utf16(finding.id.units())?,
        })
    }
    fn compare(&self, other: &Self, collation: &Collation) -> Ordering {
        collation
            .compare(&self.scope, &other.scope)
            .then_with(|| collation.compare(&self.kind, &other.kind))
            .then_with(|| collation.compare(&self.id, &other.id))
    }
}
pub fn unreachable_ledger_of(
    entries: &[Arc<UnreachableLedgerEntry>],
    collation: &Collation,
) -> Result<UnreachableLedger, CollationError> {
    let mut by_key = IndexMap::new();
    for entry in entries {
        by_key
            .entry(finding_key(&entry.finding))
            .or_insert_with(|| Arc::clone(entry));
    }
    let mut prepared = by_key
        .into_values()
        .map(|entry| FindingInput::new(&entry.finding).map(|input| (entry, input)))
        .collect::<Result<Vec<_>, _>>()?;
    prepared.sort_by(|a, b| a.1.compare(&b.1, collation));
    Ok(UnreachableLedger {
        entries: prepared.into_iter().map(|(entry, _)| entry).collect(),
    })
}
fn field(path: &[PathSegment], name: &str) -> Vec<PathSegment> {
    let mut path = path.to_vec();
    path.push(PathSegment::Field(name.into()));
    path
}
fn strict(object: &JsObject, allowed: &[&str], path: Vec<PathSegment>) -> Result<(), InputIssue> {
    let unknown: Vec<_> = object_keys(object)
        .into_iter()
        .filter(|key| !allowed.iter().any(|name| *key == name))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(InputIssue::unrecognized_keys(path, &unknown))
    }
}
fn parse_entry(
    value: &JsValue,
    path: Vec<PathSegment>,
) -> Result<Arc<UnreachableLedgerEntry>, InputIssue> {
    let object = value
        .as_object()
        .ok_or_else(|| InputIssue::invalid_type(path.clone(), "object", Some(value)))?;
    let scope =
        nonempty_string(object.get(&JsString::from("scope")), field(&path, "scope"))?.clone();
    let kind = match object
        .get(&JsString::from("kind"))
        .and_then(JsValue::as_string)
        .map(JsString::to_lossy)
        .as_deref()
    {
        Some("dead") => UnreachableCategory::Dead,
        Some("only-called-from-tests") => UnreachableCategory::OnlyCalledFromTests,
        _ => {
            return Err(InputIssue::new(
                field(&path, "kind"),
                "Invalid option: expected one of \"dead\"|\"only-called-from-tests\"",
            ));
        }
    };
    let id = nonempty_string(object.get(&JsString::from("id")), field(&path, "id"))?.clone();
    let reason = object.get(&JsString::from("reason"));
    let Some(JsValue::String(reason)) = reason else {
        return Err(InputIssue::invalid_type(
            field(&path, "reason"),
            "string",
            reason,
        ));
    };
    if reason.trim_js().is_empty() {
        return Err(InputIssue::new(
            field(&path, "reason"),
            "a reason must not be blank",
        ));
    }
    strict(object, &["scope", "kind", "id", "reason"], path)?;
    Ok(Arc::new(UnreachableLedgerEntry {
        finding: UnreachableFinding { scope, kind, id },
        reason: reason.clone(),
    }))
}
fn parse_value(value: &JsValue) -> Result<UnreachableLedger, InputIssue> {
    let object = value
        .as_object()
        .ok_or_else(|| InputIssue::invalid_type(vec![], "object", Some(value)))?;
    let input = object.get(&JsString::from("entries"));
    let Some(JsValue::Array(values)) = input else {
        return Err(InputIssue::invalid_type(
            vec![PathSegment::Field("entries".into())],
            "array",
            input,
        ));
    };
    let mut entries = Vec::new();
    for (index, value) in values.iter().enumerate() {
        entries.push(parse_entry(
            value,
            vec![
                PathSegment::Field("entries".into()),
                PathSegment::Index(index),
            ],
        )?);
    }
    strict(object, &["entries"], vec![])?;
    let mut seen = IndexSet::new();
    for (index, entry) in entries.iter().enumerate() {
        let key = finding_key(&entry.finding);
        if !seen.insert(key.clone()) {
            return Err(InputIssue::new(
                vec![
                    PathSegment::Field("entries".into()),
                    PathSegment::Index(index),
                ],
                format!("duplicate entry {key}"),
            ));
        }
    }
    Ok(UnreachableLedger { entries })
}
pub(super) fn parse_unreachable_ledger_unordered(text: &JsString) -> UnreachableLedgerRead {
    let Ok(value) = JsValue::parse_js(text) else {
        return UnreachableLedgerRead::Invalid {
            message: "not valid JSON".into(),
            source: None,
        };
    };
    match parse_value(&value) {
        Ok(ledger) => UnreachableLedgerRead::Read { ledger },
        Err(issue) => {
            let mut message = issue_location(&issue);
            message.push_str(": ");
            message.extend(issue.message());
            UnreachableLedgerRead::Invalid {
                message,
                source: None,
            }
        }
    }
}
pub(super) fn read_unreachable_ledger_unordered(file: &JsString) -> UnreachableLedgerRead {
    match fs::read(file.to_lossy()) {
        Ok(bytes) => parse_unreachable_ledger_unordered(&JsString::from(
            String::from_utf8_lossy(&bytes).as_ref(),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => UnreachableLedgerRead::Absent,
        Err(source) => UnreachableLedgerRead::Invalid {
            message: "unreadable".into(),
            source: Some(source),
        },
    }
}

fn ordered_read(
    read: UnreachableLedgerRead,
    collation: &Collation,
) -> Result<UnreachableLedgerRead, CollationError> {
    match read {
        UnreachableLedgerRead::Read { ledger } => Ok(UnreachableLedgerRead::Read {
            ledger: unreachable_ledger_of(&ledger.entries, collation)?,
        }),
        other => Ok(other),
    }
}
pub fn parse_unreachable_ledger(
    text: &JsString,
    collation: &Collation,
) -> Result<UnreachableLedgerRead, CollationError> {
    ordered_read(parse_unreachable_ledger_unordered(text), collation)
}
pub fn read_unreachable_ledger(
    file: &JsString,
    collation: &Collation,
) -> Result<UnreachableLedgerRead, CollationError> {
    ordered_read(read_unreachable_ledger_unordered(file), collation)
}

#[derive(Debug)]
pub enum UnreachableSerializeError {
    Collation(CollationError),
    Json(serde_json::Error),
}
impl std::fmt::Display for UnreachableSerializeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(formatter),
            Self::Json(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for UnreachableSerializeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Json(error) => error,
        })
    }
}

pub fn serialize_unreachable_ledger(
    ledger: &UnreachableLedger,
    collation: &Collation,
) -> Result<String, UnreachableSerializeError> {
    let ordered = unreachable_ledger_of(&ledger.entries, collation)
        .map_err(UnreachableSerializeError::Collation)?;
    let mut text = crate::render::json::stable_stringify(&ordered, true)
        .map_err(UnreachableSerializeError::Json)?;
    text.push('\n');
    Ok(text)
}
#[derive(Debug)]
pub enum UnreachableWriteError {
    Collation(CollationError),
    Json(serde_json::Error),
    Io { file: JsString, source: io::Error },
}
impl std::fmt::Display for UnreachableWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(formatter),
            Self::Json(error) => error.fmt(formatter),
            Self::Io { file, source } => {
                write!(formatter, "cannot write \"{}\": {source}", file.to_lossy())
            }
        }
    }
}
impl std::error::Error for UnreachableWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Json(error) => error,
            Self::Io { source, .. } => source,
        })
    }
}
pub fn write_unreachable_ledger(
    file: &JsString,
    ledger: &UnreachableLedger,
    collation: &Collation,
) -> Result<(), UnreachableWriteError> {
    let text = serialize_unreachable_ledger(ledger, collation).map_err(|error| match error {
        UnreachableSerializeError::Collation(error) => UnreachableWriteError::Collation(error),
        UnreachableSerializeError::Json(error) => UnreachableWriteError::Json(error),
    })?;
    fs::write(file.to_lossy(), text).map_err(|source| UnreachableWriteError::Io {
        file: file.clone(),
        source,
    })
}
pub fn findings_of(
    scope: &JsString,
    unreachable: &[UnreachableSymbol],
    collation: &Collation,
) -> Result<Vec<UnreachableFinding>, CollationError> {
    let findings = unreachable
        .iter()
        .map(|symbol| UnreachableFinding {
            scope: scope.clone(),
            kind: symbol.category,
            id: symbol.id.as_str().into(),
        })
        .map(|finding| FindingInput::new(&finding).map(|input| (finding, input)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut prepared = findings;
    prepared.sort_by(|a, b| a.1.compare(&b.1, collation));
    Ok(prepared.into_iter().map(|(finding, _)| finding).collect())
}
#[derive(Debug, Serialize)]
pub struct UnreachableReconciliation<'a> {
    pub scope: &'a JsString,
    pub gated: &'a [UnreachableCategory],
    pub unrecorded: Vec<&'a UnreachableFinding>,
    pub pruned: Vec<Arc<UnreachableLedgerEntry>>,
    pub kept: UnreachableLedger,
}
pub fn reconcile_unreachable<'a>(
    ledger: &UnreachableLedger,
    scope: &'a JsString,
    findings: &'a [UnreachableFinding],
    gated: &'a [UnreachableCategory],
    collation: &Collation,
) -> Result<UnreachableReconciliation<'a>, CollationError> {
    let measured: Vec<_> = findings
        .iter()
        .filter(|f| gated.contains(&f.kind))
        .collect();
    let measured_keys: IndexSet<_> = measured
        .iter()
        .map(|finding| finding_key(finding))
        .collect();
    let recorded_keys: IndexSet<_> = ledger
        .entries
        .iter()
        .map(|entry| finding_key(&entry.finding))
        .collect();
    let gone = |entry: &UnreachableLedgerEntry| {
        entry.finding.scope == *scope
            && gated.contains(&entry.finding.kind)
            && !measured_keys.contains(&finding_key(&entry.finding))
    };
    Ok(UnreachableReconciliation {
        scope,
        gated,
        unrecorded: measured
            .into_iter()
            .filter(|finding| !recorded_keys.contains(&finding_key(finding)))
            .collect(),
        pruned: ledger
            .entries
            .iter()
            .filter(|entry| gone(entry))
            .cloned()
            .collect(),
        kept: unreachable_ledger_of(
            &ledger
                .entries
                .iter()
                .filter(|entry| !gone(entry))
                .cloned()
                .collect::<Vec<_>>(),
            collation,
        )?,
    })
}
pub fn with_accepted_findings(
    ledger: &UnreachableLedger,
    accepted: &[&UnreachableFinding],
    reason: &JsString,
    collation: &Collation,
) -> Result<UnreachableLedger, CollationError> {
    let entries: Vec<_> = ledger
        .entries
        .iter()
        .cloned()
        .chain(accepted.iter().map(|finding| {
            Arc::new(UnreachableLedgerEntry {
                finding: UnreachableFinding {
                    scope: finding.scope.clone(),
                    kind: finding.kind,
                    id: finding.id.clone(),
                },
                reason: reason.clone(),
            })
        }))
        .collect();
    unreachable_ledger_of(&entries, collation)
}
