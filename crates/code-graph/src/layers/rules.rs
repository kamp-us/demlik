use crate::text::JsString;
use serde::{Deserialize, Serialize};
mod input;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Layer {
    pub name: JsString,
    pub paths: Vec<JsString>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AllowedEdge {
    pub from: JsString,
    pub to: JsString,
    pub sites: u64,
    pub reason: JsString,
}
#[derive(Debug, Default, Clone, Serialize)]
pub struct LayerRules {
    pub layers: Vec<Layer>,
    pub allowed: Vec<AllowedEdge>,
}
impl Layer {
    pub fn parse(value: &crate::text::JsValue) -> Result<Self, crate::validation::InputIssue> {
        input::layer(value, &[])
    }
}
impl AllowedEdge {
    pub fn parse(value: &crate::text::JsValue) -> Result<Self, crate::validation::InputIssue> {
        input::allowed_edge(value, &[])
    }
}
impl LayerRules {
    pub fn parse(value: &crate::text::JsValue) -> Result<Self, crate::validation::InputIssue> {
        input::rules(value)
    }
}
