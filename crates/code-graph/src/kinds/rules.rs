use super::conventions::{EntryExportConvention, EntryExportConventions};
use super::presets::EntryExportPresetName;
use crate::project::locale_compare_units;
use crate::text::JsString;
use crate::text::{JsObject, JsValue, object_keys};
use crate::validation::{InputIssue, PathSegment, record_object};
use indexmap::IndexMap;
use serde::Serialize;

pub use crate::text::JsRegex;
pub type PatternGroup = IndexMap<JsString, Vec<JsString>>;
#[derive(Debug)]
pub struct CompiledRule {
    pub key: JsString,
    pub patterns: Vec<JsRegex>,
}
pub fn compile_group(group: &PatternGroup) -> Result<Vec<CompiledRule>, regress::Error> {
    let mut keys: Vec<_> = group.keys().collect();
    keys.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    keys.into_iter()
        .map(|key| {
            Ok(CompiledRule {
                key: key.clone(),
                patterns: group[key]
                    .iter()
                    .map(JsRegex::new)
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect()
}
pub fn matching_rules(rules: &[CompiledRule], value: &JsString) -> Vec<JsString> {
    rules
        .iter()
        .filter(|rule| rule.patterns.iter().any(|pattern| pattern.test(value)))
        .map(|rule| rule.key.clone())
        .collect()
}

#[derive(Debug, Clone)]
pub struct EntryReachRules {
    pub service_binding: Vec<JsString>,
    pub platform: Vec<JsString>,
}
#[derive(Debug, Clone)]
pub struct NodeKindRules {
    pub entry_names: PatternGroup,
    pub entry_base_classes: PatternGroup,
    pub entry_reach: EntryReachRules,
    pub entry_guard_properties: PatternGroup,
    pub entry_file_patterns: PatternGroup,
    pub entry_export_conventions: EntryExportConventions,
    pub entry_export_presets: Vec<EntryExportPresetName>,
    pub test_support_file_patterns: PatternGroup,
    pub auth_names: PatternGroup,
    pub auth_callees: PatternGroup,
    pub effect_declarations: PatternGroup,
}
#[derive(Debug)]
pub enum RuleInputError {
    Issue(InputIssue),
    TypeError(JsString),
}
impl std::fmt::Display for RuleInputError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issue(issue) => issue.fmt(formatter),
            Self::TypeError(message) => formatter.write_str(&message.to_lossy()),
        }
    }
}
impl std::error::Error for RuleInputError {}
fn issue(path: &[PathSegment], message: impl Into<JsString>) -> RuleInputError {
    RuleInputError::Issue(InputIssue::new(path.to_vec(), message))
}
fn invalid(path: &[PathSegment], expected: &str, value: Option<&JsValue>) -> RuleInputError {
    let received = match value {
        None => "undefined",
        Some(JsValue::Null) => "null",
        Some(JsValue::Bool(_)) => "boolean",
        Some(JsValue::Number(number)) if number.is_nan() => "NaN",
        Some(JsValue::Number(_)) => "number",
        Some(JsValue::String(_)) => "string",
        Some(JsValue::Array(_)) => "array",
        Some(JsValue::Object(_)) => "object",
    };
    issue(
        path,
        format!("Invalid input: expected {expected}, received {received}"),
    )
}
fn at(path: &[PathSegment], key: &JsString) -> Vec<PathSegment> {
    let mut path = path.to_vec();
    path.push(PathSegment::Field(key.clone()));
    path
}
fn indexed(path: &[PathSegment], index: usize) -> Vec<PathSegment> {
    let mut path = path.to_vec();
    path.push(PathSegment::Index(index));
    path
}
fn object<'a>(
    value: Option<&'a JsValue>,
    path: &[PathSegment],
    record: bool,
) -> Result<&'a JsObject, RuleInputError> {
    let Some(JsValue::Object(object)) = value else {
        return Err(invalid(
            path,
            if record { "record" } else { "object" },
            value,
        ));
    };
    if record {
        match record_object(value.expect("object input was checked above")) {
            Ok(Some(_)) => {}
            Ok(None) => return Err(invalid(path, "record", value)),
            Err(error) => return Err(RuleInputError::TypeError(error.message().clone())),
        }
    }
    Ok(object)
}
fn strict(object: &JsObject, allowed: &[&str], path: &[PathSegment]) -> Result<(), RuleInputError> {
    let keys: Vec<_> = object_keys(object)
        .into_iter()
        .filter(|key| !allowed.iter().any(|name| *key == name))
        .collect();
    if keys.is_empty() {
        return Ok(());
    }
    let mut message = JsString::from(if keys.len() == 1 {
        "Unrecognized key: "
    } else {
        "Unrecognized keys: "
    });
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            message.push_str(", ");
        }
        message.push_str("\"");
        message.extend(key);
        message.push_str("\"");
    }
    Err(issue(path, message))
}
fn strings(
    value: Option<&JsValue>,
    path: &[PathSegment],
    nonempty: bool,
) -> Result<Vec<JsString>, RuleInputError> {
    let Some(JsValue::Array(values)) = value else {
        return Err(invalid(path, "array", value));
    };
    let mut out = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let path = indexed(path, index);
        let Some(text) = value.as_string() else {
            return Err(invalid(&path, "string", Some(value)));
        };
        if nonempty && text.is_empty() {
            return Err(issue(
                &path,
                "Too small: expected string to have >=1 characters",
            ));
        }
        out.push(text.clone());
    }
    if nonempty && values.is_empty() {
        return Err(issue(path, "Too small: expected array to have >=1 items"));
    }
    Ok(out)
}
fn group(value: &JsValue, path: &[PathSegment]) -> Result<PatternGroup, RuleInputError> {
    let object = object(Some(value), path, true)?;
    let mut out = PatternGroup::new();
    for key in object_keys(object) {
        if key != "__proto__" {
            out.insert(
                key.clone(),
                strings(Some(&object[key]), &at(path, key), false)?,
            );
        }
    }
    Ok(out)
}
pub(super) fn conventions(
    value: &JsValue,
    path: &[PathSegment],
) -> Result<EntryExportConventions, RuleInputError> {
    let record = object(Some(value), path, true)?;
    let mut out = EntryExportConventions::new();
    for name in object_keys(record) {
        if name == "__proto__" {
            continue;
        }
        let path = at(path, name);
        let fields = object(Some(&record[name]), &path, false)?;
        let files = fields.get(&JsString::from("files"));
        let Some(files) = files.and_then(JsValue::as_string) else {
            return Err(invalid(&at(&path, &"files".into()), "string", files));
        };
        if files.is_empty() {
            return Err(issue(
                &at(&path, &"files".into()),
                "Too small: expected string to have >=1 characters",
            ));
        }
        let exports = strings(
            fields.get(&JsString::from("exports")),
            &at(&path, &"exports".into()),
            true,
        )?;
        strict(fields, &["files", "exports"], &path)?;
        out.insert(
            name.clone(),
            EntryExportConvention {
                files: files.clone(),
                exports,
            },
        );
    }
    Ok(out)
}
impl NodeKindRules {
    pub fn parse(value: &JsValue) -> Result<Self, RuleInputError> {
        let fields = object(Some(value), &[], false)?;
        // Zod visits later fields after ordinary issues; a thrown record error still wins.
        for name in [
            "entryNames",
            "entryBaseClasses",
            "entryGuardProperties",
            "entryFilePatterns",
            "entryExportConventions",
            "testSupportFilePatterns",
            "authNames",
            "authCallees",
            "effectDeclarations",
        ] {
            if let Some(value) = fields.get(&JsString::from(name))
                && let Err(error @ RuleInputError::TypeError(_)) = object(Some(value), &[], true)
            {
                return Err(error);
            }
        }

        let defaults = JsValue::parse(include_str!("defaults.json"))
            .expect("checked-in primary-source defaults are valid JSON");
        let defaults = defaults
            .get("rules")
            .and_then(JsValue::as_object)
            .expect("defaults have rules");
        let get = |key: &str| {
            fields
                .get(&JsString::from(key))
                .unwrap_or(&defaults[&JsString::from(key)])
        };
        let parse_group = |key: &str| group(get(key), &[PathSegment::Field(key.into())]);
        let entry_names = parse_group("entryNames")?;
        let entry_base_classes = parse_group("entryBaseClasses")?;
        let reach_path = [PathSegment::Field("entryReach".into())];
        let reach = object(Some(get("entryReach")), &reach_path, false)?;
        let entry_reach = EntryReachRules {
            service_binding: strings(
                reach.get(&JsString::from("service-binding")),
                &at(&reach_path, &"service-binding".into()),
                false,
            )?,
            platform: strings(
                reach.get(&JsString::from("platform")),
                &at(&reach_path, &"platform".into()),
                false,
            )?,
        };
        strict(reach, &["service-binding", "platform"], &reach_path)?;
        let entry_guard_properties = parse_group("entryGuardProperties")?;
        let entry_file_patterns = parse_group("entryFilePatterns")?;
        let entry_export_conventions = conventions(
            get("entryExportConventions"),
            &[PathSegment::Field("entryExportConventions".into())],
        )?;
        let preset_path = [PathSegment::Field("entryExportPresets".into())];
        let Some(presets) = get("entryExportPresets").as_array() else {
            return Err(invalid(
                &preset_path,
                "array",
                Some(get("entryExportPresets")),
            ));
        };
        let entry_export_presets = presets
            .iter()
            .enumerate()
            .map(|(index, value)| {
                if value.as_string().is_some_and(|value| value == "nextjs") {
                    Ok(EntryExportPresetName::Nextjs)
                } else {
                    Err(issue(
                        &indexed(&preset_path, index),
                        "Invalid input: expected \"nextjs\"",
                    ))
                }
            })
            .collect::<Result<_, _>>()?;
        let test_support_file_patterns = parse_group("testSupportFilePatterns")?;
        let auth_names = parse_group("authNames")?;
        let auth_callees = parse_group("authCallees")?;
        let effect_declarations = parse_group("effectDeclarations")?;
        strict(
            fields,
            &[
                "entryNames",
                "entryBaseClasses",
                "entryReach",
                "entryGuardProperties",
                "entryFilePatterns",
                "entryExportConventions",
                "entryExportPresets",
                "testSupportFilePatterns",
                "authNames",
                "authCallees",
                "effectDeclarations",
            ],
            &[],
        )?;
        Ok(Self {
            entry_names,
            entry_base_classes,
            entry_reach,
            entry_guard_properties,
            entry_file_patterns,
            entry_export_conventions,
            entry_export_presets,
            test_support_file_patterns,
            auth_names,
            auth_callees,
            effect_declarations,
        })
    }
    fn groups(&self) -> [(&'static str, &PatternGroup); 8] {
        [
            ("entryNames", &self.entry_names),
            ("entryBaseClasses", &self.entry_base_classes),
            ("entryGuardProperties", &self.entry_guard_properties),
            ("entryFilePatterns", &self.entry_file_patterns),
            ("testSupportFilePatterns", &self.test_support_file_patterns),
            ("authNames", &self.auth_names),
            ("authCallees", &self.auth_callees),
            ("effectDeclarations", &self.effect_declarations),
        ]
    }
    pub fn regex_sources(&self) -> Vec<JsString> {
        let mut groups = self
            .groups()
            .into_iter()
            .map(|(_, group)| group)
            .collect::<Vec<_>>();
        let reach: PatternGroup = [
            (
                "service-binding".into(),
                self.entry_reach.service_binding.clone(),
            ),
            ("platform".into(), self.entry_reach.platform.clone()),
        ]
        .into_iter()
        .collect();
        groups.insert(2, &reach);
        groups
            .into_iter()
            .flat_map(|group| {
                object_keys(group)
                    .into_iter()
                    .flat_map(|key| group[key].clone())
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    pub fn as_value(&self) -> JsValue {
        let mut fields: JsObject = self
            .groups()
            .into_iter()
            .map(|(name, group)| (name.into(), group_value(group)))
            .collect();
        fields.insert(
            "entryReach".into(),
            JsValue::Object(
                [
                    (
                        "service-binding".into(),
                        string_values(&self.entry_reach.service_binding),
                    ),
                    ("platform".into(), string_values(&self.entry_reach.platform)),
                ]
                .into_iter()
                .collect(),
            ),
        );
        fields.insert(
            "entryExportConventions".into(),
            JsValue::Object(
                self.entry_export_conventions
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.clone(),
                            JsValue::Object(
                                [
                                    ("files".into(), JsValue::String(value.files.clone())),
                                    ("exports".into(), string_values(&value.exports)),
                                ]
                                .into_iter()
                                .collect(),
                            ),
                        )
                    })
                    .collect(),
            ),
        );
        fields.insert(
            "entryExportPresets".into(),
            JsValue::Array(
                self.entry_export_presets
                    .iter()
                    .map(|preset| JsValue::String(preset.as_str().into()))
                    .collect(),
            ),
        );
        let order = [
            "entryNames",
            "entryBaseClasses",
            "entryReach",
            "entryGuardProperties",
            "entryFilePatterns",
            "entryExportConventions",
            "entryExportPresets",
            "testSupportFilePatterns",
            "authNames",
            "authCallees",
            "effectDeclarations",
        ];
        JsValue::Object(
            order
                .into_iter()
                .map(|name| {
                    let key = JsString::from(name);
                    let value = fields
                        .shift_remove(&key)
                        .expect("every rules field has one serialized value");
                    (key, value)
                })
                .collect(),
        )
    }
}
fn string_values(values: &[JsString]) -> JsValue {
    JsValue::Array(values.iter().cloned().map(JsValue::String).collect())
}
fn group_value(group: &PatternGroup) -> JsValue {
    JsValue::Object(
        group
            .iter()
            .map(|(key, values)| (key.clone(), string_values(values)))
            .collect(),
    )
}
impl Default for NodeKindRules {
    fn default() -> Self {
        Self::parse(&JsValue::Object(JsObject::new()))
            .expect("checked-in rules defaults satisfy the native input contract")
    }
}
impl Serialize for NodeKindRules {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.as_value().serialize(serializer)
    }
}
