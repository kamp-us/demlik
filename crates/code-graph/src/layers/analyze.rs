use super::{
    classify::{EdgeDirection, LayerTieError, compile_matchers, direction_of, layer_of},
    resolve_target::{ResolvedTarget, create_target_resolver, create_target_resolver_text},
    rules::LayerRules,
};
use crate::{
    project::{
        LoadedProject, join_path_text, locale_compare_units, relative_path_text,
        relative_path_text_from,
    },
    syntax::imports::import_literals,
    text::JsString,
};
use serde::{Deserialize, Serialize};
use std::{io, path::Path};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerEdge {
    pub from: JsString,
    pub from_line: usize,
    pub from_layer: JsString,
    pub to: JsString,
    pub to_line: usize,
    pub to_layer: JsString,
    pub specifier: JsString,
    pub type_only: bool,
}
#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LayerCensus {
    pub down: usize,
    pub sideways: usize,
    pub up: usize,
    pub unlayered: usize,
    pub external: usize,
    pub unresolved: usize,
}
impl LayerCensus {
    fn record(&mut self, direction: EdgeDirection) {
        match direction {
            EdgeDirection::Down => self.down += 1,
            EdgeDirection::Sideways => self.sideways += 1,
            EdgeDirection::Up => self.up += 1,
            EdgeDirection::Unlayered => self.unlayered += 1,
        }
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerReport {
    pub layers: Vec<JsString>,
    pub files_scanned: usize,
    pub census: LayerCensus,
    pub violations: Vec<LayerEdge>,
    pub unresolved: Vec<JsString>,
}
#[derive(Debug)]
pub enum LayerAnalysisError {
    Pattern(regress::Error),
    Tie(LayerTieError),
    Io(io::Error),
}
impl std::fmt::Display for LayerAnalysisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pattern(error) => error.fmt(f),
            Self::Tie(error) => error.fmt(f),
            Self::Io(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for LayerAnalysisError {}
impl From<io::Error> for LayerAnalysisError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<LayerTieError> for LayerAnalysisError {
    fn from(error: LayerTieError) -> Self {
        Self::Tie(error)
    }
}
pub fn analyze_layers(
    loaded: &LoadedProject,
    repo_root: &Path,
    rules: &LayerRules,
) -> Result<LayerReport, LayerAnalysisError> {
    analyze(loaded, repo_root, rules, None)
}
pub(super) fn analyze_layers_text(
    loaded: &LoadedProject,
    root_absolute: &JsString,
    repo_root: &JsString,
    rules: &LayerRules,
) -> Result<LayerReport, LayerAnalysisError> {
    let repo_native = repo_root.to_lossy();
    analyze(
        loaded,
        Path::new(&repo_native),
        rules,
        Some((root_absolute, repo_root)),
    )
}
fn analyze(
    loaded: &LoadedProject,
    repo_root: &Path,
    rules: &LayerRules,
    text: Option<(&JsString, &JsString)>,
) -> Result<LayerReport, LayerAnalysisError> {
    let matchers = compile_matchers(&rules.layers).map_err(LayerAnalysisError::Pattern)?;
    let mut resolver = match text {
        Some((_, repo)) => create_target_resolver_text(repo)?,
        None => create_target_resolver(repo_root)?,
    };
    let mut census = LayerCensus::default();
    let mut violations = Vec::new();
    let mut unresolved = Vec::new();
    for unit in &loaded.source_files {
        let from = match text {
            // The gate loaded these relative files beneath the supplied logical root.
            Some((root, repo)) => {
                relative_path_text_from(repo, &join_path_text(root, &unit.file.as_str().into()))?
            }
            None => relative_path_text(
                repo_root,
                &unit.absolute_path.to_string_lossy().as_ref().into(),
            )?,
        };
        let from_layer = layer_of(&from, &matchers)?;
        for literal in import_literals(&unit.syntax) {
            let line = unit.syntax.line_of(literal.start);
            let file = match resolver.resolve(&from, &literal.specifier)? {
                ResolvedTarget::External => {
                    census.external += 1;
                    continue;
                }
                ResolvedTarget::Unresolved { specifier } => {
                    census.unresolved += 1;
                    let mut site = from.clone();
                    site.push_str(&format!(":{line} "));
                    site.extend(&specifier);
                    unresolved.push(site);
                    continue;
                }
                ResolvedTarget::File { file } => file,
                ResolvedTarget::Package { pkg } => pkg.entry.unwrap_or_else(|| pkg.dir.into()),
            };
            let to_layer = layer_of(&file, &matchers)?;
            let direction = direction_of(from_layer, to_layer);
            census.record(direction);
            if direction == EdgeDirection::Up
                && let (Some(from_layer), Some(to_layer)) = (from_layer, to_layer)
            {
                violations.push(LayerEdge {
                    from: from.clone(),
                    from_line: line,
                    from_layer: from_layer.name.clone(),
                    to: file,
                    to_line: 1,
                    to_layer: to_layer.name.clone(),
                    specifier: literal.specifier,
                    type_only: literal.type_only,
                });
            }
        }
    }
    violations.sort_by(|left, right| {
        locale_compare_units(left.from.units(), right.from.units())
            .then_with(|| left.from_line.cmp(&right.from_line))
            .then_with(|| locale_compare_units(left.to.units(), right.to.units()))
    });
    unresolved.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    Ok(LayerReport {
        layers: rules
            .layers
            .iter()
            .map(|layer| layer.name.clone())
            .collect(),
        files_scanned: loaded.source_files.len(),
        census,
        violations,
        unresolved,
    })
}
