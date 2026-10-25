use super::{
    analyze::{LayerAnalysisError, analyze_layers},
    config::{LayerConfigResolution, resolve_layer_rules},
    render::render_layers,
};
use crate::{engine::oxc::ParseFailure, project::load_cheap_project, text::JsString};
use serde::Serialize;
use std::path::Path;
#[derive(Debug, Clone, Copy)]
pub struct LayerGateArgs<'a> {
    pub root_absolute: &'a Path,
    pub repo_root: &'a Path,
    pub layer_rules_file: Option<&'a JsString>,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerGateResult {
    pub exit_code: u8,
    pub emitted: Vec<JsString>,
    pub reports: Vec<JsString>,
}
#[derive(Debug)]
pub enum LayerGateError {
    Project(ParseFailure),
    Analysis(LayerAnalysisError),
    Render(serde_json::Error),
}
impl std::fmt::Display for LayerGateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Project(error) => error.fmt(f),
            Self::Analysis(error) => error.fmt(f),
            Self::Render(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for LayerGateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Project(error) => error,
            Self::Analysis(error) => error,
            Self::Render(error) => error,
        })
    }
}
pub fn run_layer_gate(args: LayerGateArgs<'_>) -> Result<LayerGateResult, LayerGateError> {
    let rules = match resolve_layer_rules(args.layer_rules_file) {
        LayerConfigResolution::Resolved(rules) => rules,
        LayerConfigResolution::Refused { message } => {
            return Ok(LayerGateResult {
                exit_code: 2,
                reports: vec![message],
                ..Default::default()
            });
        }
    };
    let loaded = load_cheap_project(args.root_absolute, None).map_err(LayerGateError::Project)?;
    let analysis = match analyze_layers(&loaded, args.repo_root, &rules) {
        Ok(report) => report,
        Err(LayerAnalysisError::Tie(error)) => {
            return Ok(LayerGateResult {
                exit_code: 2,
                reports: vec![error.message()],
                ..Default::default()
            });
        }
        Err(error) => return Err(LayerGateError::Analysis(error)),
    };
    let render = render_layers(&analysis, &rules.allowed, args.json, args.pretty)
        .map_err(LayerGateError::Render)?;
    let mut payload = render.stdout;
    payload.push_str("\n");
    Ok(LayerGateResult {
        exit_code: render.exit_code,
        emitted: vec![payload],
        reports: Vec::new(),
    })
}
