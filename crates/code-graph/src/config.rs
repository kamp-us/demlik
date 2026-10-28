//! File decoding and refusal text shared by the source config entry points.
use crate::{
    text::{JsString, JsValue},
    validation::{InputIssue, PathSegment},
};
use std::{fs, path::Path};

use crate::{
    collapse::settings::CollapseSettings,
    kinds::{
        glob::{GlobError, glob_to_regexp},
        presets::entry_export_preset_names,
        rules::{NodeKindRules, RuleInputError},
    },
    schema::Thresholds,
    text::{JsRegex, object_keys},
};

#[derive(Debug)]
pub enum ConfigResolution<T> {
    Resolved(T),
    Refused { message: JsString },
}

#[derive(Debug)]
pub enum NodeKindConfigError {
    Rules(RuleInputError),
    Glob(GlobError),
}
impl std::fmt::Display for NodeKindConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rules(error) => error.fmt(formatter),
            Self::Glob(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for NodeKindConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Rules(error) => error,
            Self::Glob(error) => error,
        })
    }
}

pub fn resolve_thresholds(file: Option<&JsString>) -> ConfigResolution<Thresholds> {
    let Some(file) = file else {
        return ConfigResolution::Resolved(Thresholds::default());
    };
    let value = match read_config(ConfigFile::Text(file)) {
        Ok(value) => value,
        Err(message) => return ConfigResolution::Refused { message },
    };
    match Thresholds::parse(&value) {
        Ok(thresholds) => ConfigResolution::Resolved(thresholds),
        Err(issue) => ConfigResolution::Refused {
            message: invalid_config(file, &issue),
        },
    }
}

pub fn resolve_collapse_settings(file: Option<&JsString>) -> ConfigResolution<CollapseSettings> {
    let Some(file) = file else {
        return ConfigResolution::Resolved(CollapseSettings::default());
    };
    let value = match read_config(ConfigFile::Text(file)) {
        Ok(value) => value,
        Err(message) => return ConfigResolution::Refused { message },
    };
    match CollapseSettings::parse(&value) {
        Ok(settings) => ConfigResolution::Resolved(settings),
        Err(issue) => ConfigResolution::Refused {
            message: invalid_config(file, &issue),
        },
    }
}

pub fn resolve_node_kind_rules(
    file: Option<&JsString>,
) -> Result<ConfigResolution<NodeKindRules>, NodeKindConfigError> {
    let rules = if let Some(file) = file {
        let value = match read_config(ConfigFile::Text(file)) {
            Ok(value) => value,
            Err(message) => return Ok(ConfigResolution::Refused { message }),
        };
        match NodeKindRules::parse(&value) {
            Ok(rules) => rules,
            Err(RuleInputError::Issue(issue)) => {
                return Ok(ConfigResolution::Refused {
                    message: invalid_config(file, &issue),
                });
            }
            Err(error) => return Err(NodeKindConfigError::Rules(error)),
        }
    } else {
        NodeKindRules::default()
    };
    for source in rules.regex_sources() {
        if JsRegex::new(&source).is_err() {
            let mut message = JsString::from("invalid regular expression in node-kind rules: ");
            message.extend(&source);
            return Ok(ConfigResolution::Refused { message });
        }
    }
    for name in object_keys(&rules.entry_export_conventions) {
        match glob_to_regexp(&rules.entry_export_conventions[name].files) {
            Ok(_) => {}
            Err(GlobError::Syntax(error)) => {
                let mut message = JsString::from("invalid glob in entry-export convention \"");
                message.extend(name);
                message.push_str("\": ");
                message.extend(&error);
                message.push_str(".");
                return Ok(ConfigResolution::Refused { message });
            }
            Err(error) => return Err(NodeKindConfigError::Glob(error)),
        }
    }
    Ok(ConfigResolution::Resolved(rules))
}

pub fn with_entry_presets(
    mut rules: NodeKindRules,
    names: &[JsString],
) -> ConfigResolution<NodeKindRules> {
    let known = entry_export_preset_names();
    let mut presets = Vec::new();
    for &preset in &rules.entry_export_presets {
        if !presets.contains(&preset) {
            presets.push(preset);
        }
    }
    for name in names {
        let Some(&preset) = known.iter().find(|preset| name == preset.as_str()) else {
            let mut message = JsString::from("unknown --entry-preset \"");
            message.extend(name);
            message.push_str("\"; expected one of: ");
            message.push_str(
                &known
                    .iter()
                    .map(|preset| preset.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            message.push_str(".");
            return ConfigResolution::Refused { message };
        };
        if !presets.contains(&preset) {
            presets.push(preset);
        }
    }
    // The frozen schema has one preset variant; deduplication leaves at most one value.
    rules.entry_export_presets = presets;
    ConfigResolution::Resolved(rules)
}

pub(crate) enum ConfigFile<'a> {
    Native(&'a Path),
    Text(&'a JsString),
}
pub(crate) fn read_config(file: ConfigFile<'_>) -> Result<JsValue, JsString> {
    let (file, bytes) = match file {
        ConfigFile::Native(path) => (
            JsString::from(path.to_string_lossy().as_ref()),
            fs::read(path),
        ),
        ConfigFile::Text(text) => (text.clone(), fs::read(text.to_lossy())),
    };
    let bytes = bytes.map_err(|_| {
        let mut message = JsString::from("cannot read config file \"");
        message.extend(&file);
        message.push_str("\".");
        message
    })?;
    JsValue::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| {
        let mut message = JsString::from("config file \"");
        message.extend(&file);
        message.push_str("\" is not valid JSON.");
        message
    })
}
pub(crate) fn issue_location(issue: &InputIssue) -> JsString {
    let mut location = JsString::default();
    for (index, part) in issue.path().iter().enumerate() {
        if index > 0 {
            location.push_str(".");
        }
        match part {
            PathSegment::Field(field) => location.extend(field),
            PathSegment::Index(index) => location.push_str(&index.to_string()),
        }
    }
    if location.is_empty() {
        location.push_str("(root)");
    }
    location
}
pub(crate) fn invalid_config(file: &JsString, issue: &InputIssue) -> JsString {
    let mut message = JsString::from("invalid config in \"");
    message.extend(file);
    message.push_str("\": ");
    message.extend(&issue_location(issue));
    message.push_str(": ");
    message.extend(issue.message());
    message.push_str(".");
    message
}
