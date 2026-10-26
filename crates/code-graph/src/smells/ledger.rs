use super::rules::{MeasuredBy, measured_by};
use crate::{
    config::issue_location,
    project::{locale_compare, locale_compare_units},
    schema::SmellKind,
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, NumberCheck, PathSegment, checked_number, nonempty_string},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{fs, io, sync::Arc};

pub const SMELL_LEDGER_FILENAME: &str = "smell-ledger.json";
#[derive(Debug, Serialize)]
pub struct SmellFinding {
    pub rule: SmellKind,
    pub target: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub value: f64,
}
#[derive(Debug, Serialize)]
pub struct SmellLedgerEntry {
    #[serde(flatten)]
    pub finding: SmellFinding,
    pub reason: JsString,
}
#[derive(Debug, Default, Serialize)]
pub struct SmellLedger {
    pub gated: Vec<SmellKind>,
    pub entries: Vec<Arc<SmellLedgerEntry>>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SmellLedgerRead {
    Absent,
    Read {
        ledger: SmellLedger,
    },
    Invalid {
        message: JsString,
        #[serde(skip)]
        source: Option<io::Error>,
    },
}
#[derive(Debug)]
pub struct RuleNameConversionError {
    pub input: JsValue,
    pub path: Vec<PathSegment>,
}
impl RuleNameConversionError {
    pub fn name(&self) -> &'static str {
        "TypeError"
    }
    pub fn message(&self) -> JsString {
        "Cannot convert object to primitive value".into()
    }
}
impl std::fmt::Display for RuleNameConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for RuleNameConversionError {}

pub fn smell_key(finding: &SmellFinding) -> String {
    serde_json::to_string(&(finding.rule, &finding.target))
        .expect("smell identities contain encodable strings")
}
pub fn smell_ledger_of(gated: &[SmellKind], entries: &[Arc<SmellLedgerEntry>]) -> SmellLedger {
    let mut unique = Vec::new();
    for kind in gated {
        if !unique.contains(kind) {
            unique.push(*kind);
        }
    }
    unique.sort_by(|a, b| locale_compare(a.as_str(), b.as_str()));
    let mut by_key = IndexMap::new();
    for entry in entries {
        by_key
            .entry(smell_key(&entry.finding))
            .or_insert_with(|| Arc::clone(entry));
    }
    let mut entries: Vec<_> = by_key.into_values().collect();
    entries.sort_by(|a, b| {
        locale_compare(a.finding.rule.as_str(), b.finding.rule.as_str())
            .then_with(|| locale_compare_units(a.finding.target.units(), b.finding.target.units()))
    });
    SmellLedger {
        gated: unique,
        entries,
    }
}
pub fn needs_edges(gated: &[SmellKind]) -> bool {
    gated
        .iter()
        .any(|kind| measured_by(*kind) == MeasuredBy::Edges)
}
fn field(path: &[PathSegment], name: &str) -> Vec<PathSegment> {
    let mut out = path.to_vec();
    out.push(PathSegment::Field(name.into()));
    out
}
fn strict(
    object: &JsObject,
    allowed: &[&str],
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) {
    let unknown: Vec<_> = object_keys(object)
        .into_iter()
        .filter(|key| !allowed.iter().any(|name| *key == name))
        .collect();
    if !unknown.is_empty() {
        issues.push(InputIssue::unrecognized_keys(path, &unknown));
    }
}
// Only the String(issue.input) formatter in the frozen rule-name schema uses this
// projection. JSON has no callable own properties; an own toString therefore fails.
fn rule_input_text(value: Option<&JsValue>) -> Result<JsString, ()> {
    let Some(value) = value else {
        return Ok("undefined".into());
    };
    enum Part<'a> {
        Value(&'a JsValue, bool),
        Comma,
    }
    let mut pending = vec![Part::Value(value, false)];
    let mut out = JsString::default();
    while let Some(part) = pending.pop() {
        match part {
            Part::Comma => out.push_str(","),
            Part::Value(value, array_item) => match value {
                JsValue::Null => {
                    if !array_item {
                        out.push_str("null")
                    }
                }
                JsValue::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
                JsValue::Number(value) => out.push_str(&crate::render::text::number(*value)),
                JsValue::String(value) => out.extend(value),
                JsValue::Object(object) => {
                    if object.contains_key(&JsString::from("toString")) {
                        return Err(());
                    }
                    out.push_str("[object Object]");
                }
                JsValue::Array(values) => {
                    for (index, value) in values.iter().enumerate().rev() {
                        pending.push(Part::Value(value, true));
                        if index > 0 {
                            pending.push(Part::Comma);
                        }
                    }
                }
            },
        }
    }
    Ok(out)
}
fn rule_name(
    value: Option<&JsValue>,
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) -> Result<Option<SmellKind>, RuleNameConversionError> {
    if let Some(JsValue::String(text)) = value
        && let Some(kind) = SmellKind::ALL
            .into_iter()
            .find(|kind| text == kind.as_str())
    {
        return Ok(Some(kind));
    }
    let input = rule_input_text(value).map_err(|()| RuleNameConversionError {
        input: value
            .expect("missing input has a string representation")
            .clone(),
        path: path.clone(),
    })?;
    let mut message = JsString::from("\"");
    message.extend(&input);
    message.push_str("\" is not a smell rule; expected one of ");
    for (index, kind) in SmellKind::ALL.into_iter().enumerate() {
        if index > 0 {
            message.push_str(", ");
        }
        message.push_str(kind.as_str());
    }
    issues.push(InputIssue::new(path, message));
    Ok(None)
}
fn parse_entry(
    value: &JsValue,
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) -> Result<Option<Arc<SmellLedgerEntry>>, RuleNameConversionError> {
    let Some(object) = value.as_object() else {
        issues.push(InputIssue::invalid_type(path, "object", Some(value)));
        return Ok(None);
    };
    let rule = rule_name(
        object.get(&JsString::from("rule")),
        field(&path, "rule"),
        issues,
    )?;
    let target = match nonempty_string(
        object.get(&JsString::from("target")),
        field(&path, "target"),
    ) {
        Ok(value) => Some(value.clone()),
        Err(issue) => {
            issues.push(issue);
            None
        }
    };
    let value = match object.get(&JsString::from("value")) {
        Some(value) => match checked_number(
            value,
            field(&path, "value"),
            NumberCheck::Integer {
                minimum: 0.0,
                maximum: None,
            },
        ) {
            Ok(value) => Some(value),
            Err(issue) => {
                issues.push(issue);
                None
            }
        },
        None => {
            issues.push(InputIssue::invalid_type(
                field(&path, "value"),
                "number",
                None,
            ));
            None
        }
    };
    let reason = match object.get(&JsString::from("reason")) {
        Some(JsValue::String(text)) => {
            if text.trim_js().is_empty() {
                issues.push(InputIssue::new(
                    field(&path, "reason"),
                    "a reason must not be blank",
                ));
            }
            Some(text.clone())
        }
        value => {
            issues.push(InputIssue::invalid_type(
                field(&path, "reason"),
                "string",
                value,
            ));
            None
        }
    };
    strict(object, &["rule", "target", "value", "reason"], path, issues);
    Ok(match (rule, target, value, reason) {
        (Some(rule), Some(target), Some(value), Some(reason)) => Some(Arc::new(SmellLedgerEntry {
            finding: SmellFinding {
                rule,
                target,
                value,
            },
            reason,
        })),
        _ => None,
    })
}
fn parse_value(
    value: &JsValue,
) -> Result<Result<SmellLedger, InputIssue>, RuleNameConversionError> {
    let Some(object) = value.as_object() else {
        return Ok(Err(InputIssue::invalid_type(vec![], "object", Some(value))));
    };
    let mut issues = Vec::new();
    let mut gated = Vec::new();
    let mut entries = Vec::new();
    match object.get(&JsString::from("gated")) {
        None => {}
        Some(JsValue::Array(values)) => {
            for (index, value) in values.iter().enumerate() {
                if let Some(kind) = rule_name(
                    Some(value),
                    vec![
                        PathSegment::Field("gated".into()),
                        PathSegment::Index(index),
                    ],
                    &mut issues,
                )? {
                    gated.push(kind);
                }
            }
        }
        value => issues.push(InputIssue::invalid_type(
            vec![PathSegment::Field("gated".into())],
            "array",
            value,
        )),
    }
    match object.get(&JsString::from("entries")) {
        None => {}
        Some(JsValue::Array(values)) => {
            for (index, value) in values.iter().enumerate() {
                if let Some(entry) = parse_entry(
                    value,
                    vec![
                        PathSegment::Field("entries".into()),
                        PathSegment::Index(index),
                    ],
                    &mut issues,
                )? {
                    entries.push(entry);
                }
            }
        }
        value => issues.push(InputIssue::invalid_type(
            vec![PathSegment::Field("entries".into())],
            "array",
            value,
        )),
    }
    strict(object, &["gated", "entries"], vec![], &mut issues);
    if let Some(issue) = issues.into_iter().next() {
        return Ok(Err(issue));
    }
    let mut seen = IndexSet::new();
    for (index, kind) in gated.iter().enumerate() {
        if !seen.insert(kind.as_str()) {
            return Ok(Err(InputIssue::new(
                vec![
                    PathSegment::Field("gated".into()),
                    PathSegment::Index(index),
                ],
                "duplicate gated rule",
            )));
        }
    }
    let mut seen = IndexSet::new();
    for (index, entry) in entries.iter().enumerate() {
        if !seen.insert(smell_key(&entry.finding)) {
            return Ok(Err(InputIssue::new(
                vec![
                    PathSegment::Field("entries".into()),
                    PathSegment::Index(index),
                ],
                "duplicate entry",
            )));
        }
    }
    Ok(Ok(smell_ledger_of(&gated, &entries)))
}
pub fn parse_smell_ledger(text: &JsString) -> Result<SmellLedgerRead, RuleNameConversionError> {
    let Ok(value) = JsValue::parse_js(text) else {
        return Ok(SmellLedgerRead::Invalid {
            message: "not valid JSON".into(),
            source: None,
        });
    };
    Ok(match parse_value(&value)? {
        Ok(ledger) => SmellLedgerRead::Read { ledger },
        Err(issue) => {
            let mut message = issue_location(&issue);
            message.push_str(": ");
            message.extend(issue.message());
            SmellLedgerRead::Invalid {
                message,
                source: None,
            }
        }
    })
}
pub fn read_smell_ledger(file: &JsString) -> Result<SmellLedgerRead, RuleNameConversionError> {
    match fs::read(file.to_lossy()) {
        Ok(bytes) => parse_smell_ledger(&JsString::from(String::from_utf8_lossy(&bytes).as_ref())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SmellLedgerRead::Absent),
        Err(source) => Ok(SmellLedgerRead::Invalid {
            message: "unreadable".into(),
            source: Some(source),
        }),
    }
}
