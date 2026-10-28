use super::{
    analyze::{LayerAnalysisError, analyze, analyze_layers_text},
    config::{LayerConfigResolution, resolve_layer_rules},
    render::{LayerRenderError, render_layers},
};
use crate::{
    project::{Collation, CollationError, ProjectLoadError, load_cheap_project_request},
    text::JsString,
};
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
    Collation(CollationError),
    Project(ProjectLoadError),
    Analysis(LayerAnalysisError),
    Render(serde_json::Error),
}
impl std::fmt::Display for LayerGateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(f),
            Self::Project(error) => error.fmt(f),
            Self::Analysis(error) => error.fmt(f),
            Self::Render(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for LayerGateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Project(error) => error,
            Self::Analysis(error) => error,
            Self::Render(error) => error,
        })
    }
}
#[derive(Debug, Clone, Copy)]
pub(crate) struct LayerGateTextArgs<'a> {
    pub root_absolute: &'a JsString,
    pub repo_root: &'a JsString,
    pub layer_rules_file: Option<&'a JsString>,
    pub json: bool,
    pub pretty: bool,
}
pub fn run_layer_gate(
    args: LayerGateArgs<'_>,
    collation: &Collation,
) -> Result<LayerGateResult, LayerGateError> {
    run(args, None, || Ok(collation))
}
pub(crate) fn run_layer_gate_text<'c>(
    args: LayerGateTextArgs<'_>,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<LayerGateResult, LayerGateError> {
    let root_native = args.root_absolute.to_lossy();
    let repo_native = args.repo_root.to_lossy();
    run(
        LayerGateArgs {
            root_absolute: Path::new(&root_native),
            repo_root: Path::new(&repo_native),
            layer_rules_file: args.layer_rules_file,
            json: args.json,
            pretty: args.pretty,
        },
        Some((args.root_absolute, args.repo_root)),
        request,
    )
}
fn run<'c>(
    args: LayerGateArgs<'_>,
    text: Option<(&JsString, &JsString)>,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<LayerGateResult, LayerGateError> {
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
    let mut retained = None;
    let mut request = Some(request);
    let mut request = || {
        if let Some(collation) = retained {
            return Ok(collation);
        }
        let collation = request.take().expect("layers request one borrowed handle")()?;
        retained = Some(collation);
        Ok(collation)
    };
    let loaded = load_cheap_project_request(args.root_absolute, None, &mut request)
        .map_err(LayerGateError::Project)?;
    let measured = match text {
        Some((root, repo)) => analyze_layers_text(&loaded, root, repo, &rules, &mut request),
        None => analyze(&loaded, args.repo_root, &rules, None, request),
    };
    let (analysis, collation) = match measured {
        Ok(report) => report,
        Err(LayerAnalysisError::Tie(error)) => {
            return Ok(LayerGateResult {
                exit_code: 2,
                reports: vec![error.message()],
                ..Default::default()
            });
        }
        Err(LayerAnalysisError::Collation(error)) => return Err(LayerGateError::Collation(error)),
        Err(error) => return Err(LayerGateError::Analysis(error)),
    };
    let render = render_layers(&analysis, &rules.allowed, args.json, args.pretty, collation)
        .map_err(|error| match error {
            LayerRenderError::Json(error) => LayerGateError::Render(error),
            LayerRenderError::Collation(error) => LayerGateError::Collation(error),
        })?;
    let mut payload = render.stdout;
    payload.push_str("\n");
    Ok(LayerGateResult {
        exit_code: render.exit_code,
        emitted: vec![payload],
        reports: Vec::new(),
    })
}
