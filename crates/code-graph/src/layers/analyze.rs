use super::{
    classify::{
        EdgeDirection, LayerTieError, compile_matchers_unordered, direction_of, layer_of,
        order_matchers,
    },
    resolve_target::{ResolvedTarget, create_target_resolver, create_target_resolver_text},
    rules::LayerRules,
};
use crate::{
    project::{
        Collation, CollationError, CollationInput, LoadedProject, join_path_text,
        relative_path_text, relative_path_text_from,
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
    Collation(CollationError),
    Pattern(regress::Error),
    Tie(LayerTieError),
    Io(io::Error),
}
impl std::fmt::Display for LayerAnalysisError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(f),
            Self::Pattern(error) => error.fmt(f),
            Self::Tie(error) => error.fmt(f),
            Self::Io(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for LayerAnalysisError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Pattern(error) => error,
            Self::Tie(error) => error,
            Self::Io(error) => error,
        })
    }
}
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
    collation: &Collation,
) -> Result<LayerReport, LayerAnalysisError> {
    analyze(loaded, repo_root, rules, None, || Ok(collation)).map(|(report, _)| report)
}
pub(super) fn analyze_layers_text<'c>(
    loaded: &LoadedProject,
    root_absolute: &JsString,
    repo_root: &JsString,
    rules: &LayerRules,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<(LayerReport, &'c Collation), LayerAnalysisError> {
    let repo_native = repo_root.to_lossy();
    analyze(
        loaded,
        Path::new(&repo_native),
        rules,
        Some((root_absolute, repo_root)),
        request,
    )
}
pub(super) fn analyze<'c>(
    loaded: &LoadedProject,
    repo_root: &Path,
    rules: &LayerRules,
    text: Option<(&JsString, &JsString)>,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<(LayerReport, &'c Collation), LayerAnalysisError> {
    let matchers =
        compile_matchers_unordered(&rules.layers).map_err(LayerAnalysisError::Pattern)?;
    let collation = request().map_err(LayerAnalysisError::Collation)?;
    let matchers = order_matchers(matchers, collation).map_err(LayerAnalysisError::Collation)?;
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
    let mut violations = violations
        .into_iter()
        .map(|edge| {
            let from = CollationInput::from_utf16(edge.from.units())?;
            let to = CollationInput::from_utf16(edge.to.units())?;
            Ok((edge, from, to))
        })
        .collect::<Result<Vec<_>, CollationError>>()
        .map_err(LayerAnalysisError::Collation)?;
    let mut unresolved = unresolved
        .into_iter()
        .map(|value| CollationInput::from_utf16(value.units()).map(|input| (value, input)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(LayerAnalysisError::Collation)?;
    violations.sort_by(|a, b| {
        collation
            .compare(&a.1, &b.1)
            .then_with(|| a.0.from_line.cmp(&b.0.from_line))
            .then_with(|| collation.compare(&a.2, &b.2))
    });
    unresolved.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok((
        LayerReport {
            layers: rules
                .layers
                .iter()
                .map(|layer| layer.name.clone())
                .collect(),
            files_scanned: loaded.source_files.len(),
            census,
            violations: violations.into_iter().map(|(edge, _, _)| edge).collect(),
            unresolved: unresolved.into_iter().map(|(value, _)| value).collect(),
        },
        collation,
    ))
}
