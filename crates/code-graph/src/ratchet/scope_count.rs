use crate::{
    text::{JsObject, JsString, JsValue, object_keys, object_prototype_function_name},
    validation::{InputIssue, PathSegment, RecordTypeError, record_object},
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};
mod ordering;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ScopeCountCeilings {
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub default: f64,
    #[serde(serialize_with = "serialize_scopes")]
    pub scopes: IndexMap<JsString, f64>,
}
fn serialize_scopes<S: Serializer>(
    scopes: &IndexMap<JsString, f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    JsValue::Object(
        scopes
            .iter()
            .map(|(scope, count)| (scope.clone(), JsValue::Number(*count)))
            .collect(),
    )
    .serialize(serializer)
}
#[derive(Clone, Debug, PartialEq)]
pub enum CeilingValue {
    Number(f64),
    InheritedFunction(JsString),
    ObjectPrototype,
}
impl CeilingValue {
    pub(crate) fn text(&self) -> JsString {
        match self {
            Self::Number(value) => crate::render::text::number(*value).into(),
            Self::ObjectPrototype => "[object Object]".into(),
            Self::InheritedFunction(name) => {
                let mut text = JsString::from("function ");
                text.extend(name);
                text.push_str("() { [native code] }");
                text
            }
        }
    }
    pub(crate) fn number_for_comparison(&self) -> f64 {
        match self {
            Self::Number(number) => *number,
            _ => f64::NAN,
        }
    }
    fn is_function(&self) -> bool {
        matches!(self, Self::InheritedFunction(_))
    }
}
impl Serialize for CeilingValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Number(value) => JsValue::Number(*value).serialize(serializer),
            Self::ObjectPrototype => JsValue::Object(JsObject::new()).serialize(serializer),
            Self::InheritedFunction(_) => Err(serde::ser::Error::custom(
                "an inherited function has no standalone JSON value",
            )),
        }
    }
}
impl ScopeCountCeilings {
    pub fn parse(value: &JsValue) -> Result<Self, ScopeCountInputError> {
        let Some(object) = value.as_object() else {
            return Err(ScopeCountInputError::Issues(vec![
                InputIssue::invalid_type(vec![], "object", Some(value)),
            ]));
        };
        // Record constructor errors are thrown during schema execution, before issues are returned.
        let record = object
            .get(&JsString::from("scopes"))
            .map(record_object)
            .transpose()
            .map_err(ScopeCountInputError::TypeError)?;
        let mut issues = Vec::new();
        let default = object
            .get(&JsString::from("default"))
            .and_then(|value| {
                nonnegative_integer(
                    value,
                    vec![PathSegment::Field("default".into())],
                    &mut issues,
                )
            })
            .unwrap_or(0.0);
        let mut scopes = IndexMap::new();
        if let Some(record) = record {
            match record {
                None => issues.push(InputIssue::invalid_type(
                    vec![PathSegment::Field("scopes".into())],
                    "record",
                    object.get(&JsString::from("scopes")),
                )),
                Some(record) => {
                    for key in object_keys(record) {
                        if key == "__proto__" {
                            continue;
                        }
                        if let Some(number) = nonnegative_integer(
                            &record[key],
                            vec![
                                PathSegment::Field("scopes".into()),
                                PathSegment::Field(key.clone()),
                            ],
                            &mut issues,
                        ) {
                            scopes.insert(key.clone(), number);
                        }
                    }
                }
            }
        }
        let unknown = object_keys(object)
            .into_iter()
            .filter(|key| **key != "default" && **key != "scopes")
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            issues.push(InputIssue::unrecognized_keys(vec![], &unknown));
        }
        if issues.is_empty() {
            Ok(Self { default, scopes })
        } else {
            Err(ScopeCountInputError::Issues(issues))
        }
    }
    pub fn ceiling_of(&self, scope: &JsString) -> CeilingValue {
        if let Some(number) = self.scopes.get(scope) {
            CeilingValue::Number(*number)
        } else if let Some(name) = object_prototype_function_name(scope) {
            CeilingValue::InheritedFunction(name)
        } else if scope == "__proto__" {
            CeilingValue::ObjectPrototype
        } else {
            CeilingValue::Number(self.default)
        }
    }
}
#[derive(Debug)]
pub enum ScopeCountInputError {
    Issues(Vec<InputIssue>),
    TypeError(RecordTypeError),
}
impl std::fmt::Display for ScopeCountInputError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issues(issues) => {
                if let Some(issue) = issues.first() {
                    issue.fmt(formatter)
                } else {
                    formatter.write_str("invalid scope ceilings")
                }
            }
            Self::TypeError(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for ScopeCountInputError {}
fn nonnegative_integer(
    value: &JsValue,
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) -> Option<f64> {
    let number = match value {
        JsValue::Number(number) if number.is_finite() => *number,
        _ => {
            issues.push(InputIssue::invalid_type(path, "number", Some(value)));
            return None;
        }
    };
    if number.fract() != 0.0 {
        issues.push(
            InputIssue::new(path, "Invalid input: expected int, received number").with_details(
                JsObject::from([
                    ("expected".into(), JsValue::String("int".into())),
                    ("format".into(), JsValue::String("safeint".into())),
                    ("code".into(), JsValue::String("invalid_type".into())),
                ]),
            ),
        );
        return None;
    }
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if number.abs() > SAFE {
        let large = number > 0.0;
        issues.push(
            InputIssue::new(
                path.clone(),
                if large {
                    "Too big: expected int to be <9007199254740991"
                } else {
                    "Too small: expected int to be >-9007199254740991"
                },
            )
            .with_details(JsObject::from([
                (
                    "code".into(),
                    JsValue::String(if large { "too_big" } else { "too_small" }.into()),
                ),
                (
                    if large { "maximum" } else { "minimum" }.into(),
                    JsValue::Number(if large { SAFE } else { -SAFE }),
                ),
                (
                    "note".into(),
                    JsValue::String("Integers must be within the safe integer range.".into()),
                ),
                ("origin".into(), JsValue::String("int".into())),
            ])),
        );
    }
    if number < 0.0 {
        issues.push(
            InputIssue::new(path, "Too small: expected number to be >=0").with_details(
                JsObject::from([
                    ("origin".into(), JsValue::String("number".into())),
                    ("code".into(), JsValue::String("too_small".into())),
                    ("minimum".into(), JsValue::Number(0.0)),
                    ("inclusive".into(), JsValue::Bool(true)),
                ]),
            ),
        );
    }
    Some(number)
}
#[derive(Clone, Debug, Serialize)]
pub struct ScopeCount {
    pub scope: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub count: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CeilingDirection {
    Exceeded,
    Slack,
}
#[derive(Clone, Debug, Serialize)]
pub struct ScopeCountViolation {
    pub scope: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub measured: f64,
    #[serde(skip_serializing_if = "CeilingValue::is_function")]
    pub ceiling: CeilingValue,
    pub direction: CeilingDirection,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub delta: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeCountVerdict {
    pub passed: bool,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub scopes_checked: f64,
    pub violations: Vec<ScopeCountViolation>,
}
pub fn evaluate_scope_ratchet(
    measurements: &[ScopeCount],
    ceilings: &ScopeCountCeilings,
) -> ScopeCountVerdict {
    let mut violations = Vec::new();
    for measurement in measurements {
        let ceiling = ceilings.ceiling_of(&measurement.scope);
        let delta = measurement.count - ceiling.number_for_comparison();
        if delta == 0.0 {
            continue;
        }
        violations.push(ScopeCountViolation {
            scope: measurement.scope.clone(),
            measured: measurement.count,
            ceiling,
            direction: if delta > 0.0 {
                CeilingDirection::Exceeded
            } else {
                CeilingDirection::Slack
            },
            delta,
        });
    }
    ordering::sort(&mut violations);
    ScopeCountVerdict {
        passed: violations.is_empty(),
        scopes_checked: measurements.len() as f64,
        violations,
    }
}
pub fn scope_of(repo_root: &JsString, absolute: &JsString) -> Result<JsString, std::io::Error> {
    let relative = crate::project::relative_path_text_from(repo_root, absolute)?;
    Ok(if relative.is_empty() {
        ".".into()
    } else {
        relative
    })
}
pub fn scopes_under(scopes: &[JsString], under: &JsString) -> Vec<JsString> {
    let mut prefix = under.clone();
    prefix.push_str("/");
    let mut out = scopes
        .iter()
        .filter(|scope| {
            under == "." || *scope == under || scope.units().starts_with(prefix.units())
        })
        .cloned()
        .collect::<Vec<_>>();
    out.sort_by(|left, right| crate::project::locale_compare_units(left.units(), right.units()));
    out
}
pub fn record_scope_ceilings(
    measurements: &[ScopeCount],
    ceilings: &ScopeCountCeilings,
) -> ScopeCountCeilings {
    let mut scopes = ceilings.scopes.clone();
    for measurement in measurements {
        // Object spread preserves an own __proto__; a later numeric setter assignment creates none.
        if measurement.scope != "__proto__" || scopes.contains_key(&measurement.scope) {
            scopes.insert(measurement.scope.clone(), measurement.count);
        }
    }
    ScopeCountCeilings {
        default: ceilings.default,
        scopes,
    }
}
#[derive(Debug)]
pub enum ScopeCeilingsResolution {
    Resolved(ScopeCountCeilings),
    Refused { message: JsString },
}
pub fn read_scope_ceilings(file: &JsString) -> Result<ScopeCeilingsResolution, RecordTypeError> {
    use crate::config::{ConfigFile, issue_location, read_config};
    if !std::path::Path::new(&file.to_lossy()).exists() {
        return Ok(ScopeCeilingsResolution::Resolved(
            ScopeCountCeilings::default(),
        ));
    }
    let value = match read_config(ConfigFile::Text(file)) {
        Ok(value) => value,
        Err(_) => {
            let mut message = JsString::from("ceilings file \"");
            message.extend(file);
            message.push_str("\" is not valid JSON.");
            return Ok(ScopeCeilingsResolution::Refused { message });
        }
    };
    match ScopeCountCeilings::parse(&value) {
        Ok(ceilings) => Ok(ScopeCeilingsResolution::Resolved(ceilings)),
        Err(ScopeCountInputError::TypeError(error)) => Err(error),
        Err(ScopeCountInputError::Issues(issues)) => {
            let issue = issues.first().expect("a schema refusal contains an issue");
            let mut message = JsString::from("invalid ceilings in \"");
            message.extend(file);
            message.push_str("\": ");
            message.extend(&issue_location(issue));
            message.push_str(": ");
            message.extend(issue.message());
            Ok(ScopeCeilingsResolution::Refused { message })
        }
    }
}
pub fn ratchet_table_lines(verdict: &ScopeCountVerdict, title: &JsString) -> Vec<JsString> {
    use crate::render::text::{join, number, pad_end, pad_end_units, pad_start};
    let interpolate = |parts: &[JsString]| join(parts.iter().cloned(), "");
    let mut lines = vec![
        interpolate(&[
            title.clone(),
            format!(
                " RATCHET FAILED — {} of {} scope(s) off their ceiling.",
                number(verdict.violations.len() as f64),
                number(verdict.scopes_checked)
            )
            .into(),
        ]),
        format!(
            "  {}{}{}  {}{}",
            pad_end("scope", 46),
            pad_start("measured", 8),
            pad_start("ceiling", 9),
            pad_end("direction", 9),
            pad_start("delta", 7)
        )
        .into(),
    ];
    for violation in &verdict.violations {
        let ceiling = violation.ceiling.text();
        let mut ceiling_column =
            JsString::from(" ".repeat(9usize.saturating_sub(ceiling.units().len())));
        ceiling_column.extend(&ceiling);
        let direction = match violation.direction {
            CeilingDirection::Exceeded => "EXCEEDED",
            CeilingDirection::Slack => "SLACK",
        };
        let sign = if violation.delta > 0.0 { "+" } else { "" };
        lines.push(interpolate(&[
            "  ".into(),
            pad_end_units(&violation.scope, 46),
            pad_start(&number(violation.measured), 8).into(),
            ceiling_column,
            format!(
                "  {}{}",
                pad_end(direction, 9),
                pad_start(&format!("{sign}{}", number(violation.delta)), 7)
            )
            .into(),
        ]));
    }
    lines
}
pub fn has_direction(verdict: &ScopeCountVerdict, direction: CeilingDirection) -> bool {
    verdict
        .violations
        .iter()
        .any(|violation| violation.direction == direction)
}
