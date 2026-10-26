use crate::{
    config::issue_location,
    project::locale_compare_units,
    schema::UnreachableCategory,
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, nonempty_string},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{fs, io, sync::Arc};

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
pub fn unreachable_ledger_of(entries: &[Arc<UnreachableLedgerEntry>]) -> UnreachableLedger {
    let mut by_key = IndexMap::new();
    for entry in entries {
        by_key
            .entry(finding_key(&entry.finding))
            .or_insert_with(|| Arc::clone(entry));
    }
    let mut entries: Vec<_> = by_key.into_values().collect();
    entries.sort_by(|a, b| {
        let (a, b) = (&a.finding, &b.finding);
        locale_compare_units(a.scope.units(), b.scope.units())
            .then_with(|| crate::project::locale_compare(a.kind.as_str(), b.kind.as_str()))
            .then_with(|| locale_compare_units(a.id.units(), b.id.units()))
    });
    UnreachableLedger { entries }
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
    Ok(unreachable_ledger_of(&entries))
}
pub fn parse_unreachable_ledger(text: &JsString) -> UnreachableLedgerRead {
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
pub fn read_unreachable_ledger(file: &JsString) -> UnreachableLedgerRead {
    match fs::read(file.to_lossy()) {
        Ok(bytes) => {
            parse_unreachable_ledger(&JsString::from(String::from_utf8_lossy(&bytes).as_ref()))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => UnreachableLedgerRead::Absent,
        Err(source) => UnreachableLedgerRead::Invalid {
            message: "unreadable".into(),
            source: Some(source),
        },
    }
}
