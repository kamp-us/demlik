use super::rules::LayerRules;
use crate::{
    config::{ConfigFile, invalid_config, read_config},
    text::JsString,
};
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
pub enum LayerConfigResolution {
    Resolved(LayerRules),
    Refused { message: JsString },
}
fn refusal(message: JsString) -> LayerConfigResolution {
    LayerConfigResolution::Refused { message }
}
pub fn resolve_layer_rules(file: Option<&JsString>) -> LayerConfigResolution {
    let rules = match file {
        None => LayerRules::default(),
        Some(file) => {
            let value = match read_config(ConfigFile::Text(file)) {
                Ok(value) => value,
                Err(message) => return refusal(message),
            };
            match LayerRules::parse(&value) {
                Ok(rules) => rules,
                Err(issue) => return refusal(invalid_config(file, &issue)),
            }
        }
    };
    if rules.layers.is_empty() {
        return refusal(
            "no layer stack declared; pass --layer-rules <file> with a `layers` array.".into(),
        );
    }
    let mut names = HashSet::new();
    let mut patterns = HashMap::new();
    for layer in &rules.layers {
        if !names.insert(layer.name.clone()) {
            let mut message = JsString::from("duplicate layer name \"");
            message.extend(&layer.name);
            message.push_str("\" in the layer declaration.");
            return refusal(message);
        }
        for pattern in &layer.paths {
            if let Some(owner) = patterns.get(pattern) {
                let mut message = JsString::from("path \"");
                message.extend(pattern);
                message.push_str("\" is declared in both \"");
                message.extend(owner);
                message.push_str("\" and \"");
                message.extend(&layer.name);
                message.push_str("\".");
                return refusal(message);
            }
            patterns.insert(pattern.clone(), layer.name.clone());
        }
    }
    LayerConfigResolution::Resolved(rules)
}
