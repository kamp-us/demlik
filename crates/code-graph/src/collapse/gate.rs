use super::{
    candidates::is_candidate_function,
    ceilings::{CEILINGS_FILENAME, render_partial_twin_ratchet},
    partial::find_partial_twins,
    settings::CollapseSettings,
};
use crate::{
    api::map::{ApiArgumentError, ApiError},
    engine::tsgo::TsgoBinary,
    extract::{
        analysis::AnalysisOptions,
        assemble::{
            AssemblyError, NodeFields, TextAssembly, assemble_graph_with_analysis_text_and_warning,
        },
    },
    kinds::rules::NodeKindRules,
    project::{
        Collation, CollationError, EdgeScope, ProjectLoadError, join_path_text,
        load_edge_project_text_request,
    },
    ratchet::scope_count::{
        ScopeCeilingsResolution, ScopeCount, ScopeCountCeilings, evaluate_scope_ratchet,
        order_scopes, read_scope_ceilings, record_scope_ceilings, scope_of, scopes_under_unordered,
    },
    render::json::stable_stringify,
    schema::Thresholds,
    text::JsString,
    validation::RecordTypeError,
};
use std::{error::Error, fs, io, path::Path};

pub(crate) struct CollapseGateArgs<'a> {
    pub root_absolute: &'a JsString,
    pub repo_root: &'a JsString,
    pub write_ceilings: bool,
    pub thresholds: &'a Thresholds,
    pub kind_rules: &'a NodeKindRules,
    pub settings: &'a CollapseSettings,
    pub json: bool,
    pub pretty: bool,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapseGateResult {
    pub exit_code: u8,
    pub emitted: Vec<JsString>,
    pub reports: Vec<JsString>,
}

#[derive(Debug)]
pub enum CollapseGateError {
    Collation(CollationError),
    Scope(io::Error),
    Load(ProjectLoadError),
    Assembly(AssemblyError),
    Record(RecordTypeError),
    Json(serde_json::Error),
    Write(ApiError),
}
impl CollapseGateError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Assembly(error) => error.name(),
            Self::Record(error) => error.name(),
            Self::Write(error) => error.name(),
            _ => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Load(error) => error.message(),
            Self::Assembly(error) => error.message(),
            Self::Record(error) => error.message().clone(),
            Self::Write(error) => error.message(),
            Self::Collation(error) => error.to_string().into(),
            Self::Scope(error) => error.to_string().into(),
            Self::Json(error) => error.to_string().into(),
        }
    }
}
impl std::fmt::Display for CollapseGateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message().to_lossy())
    }
}
impl Error for CollapseGateError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Scope(error) => error,
            Self::Load(error) => error,
            Self::Assembly(error) => error,
            Self::Record(error) => error,
            Self::Json(error) => error,
            Self::Write(error) => error,
        })
    }
}

fn measure<'c>(
    scopes: &[JsString],
    args: &CollapseGateArgs<'_>,
    binary: &TsgoBinary,
    warning: &mut dyn FnMut(&JsString),
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<Vec<ScopeCount>, CollapseGateError> {
    let repo_native = args.repo_root.to_lossy();
    let repo_root = Path::new(&repo_native);
    let mut request = Some(request);
    let mut collation = None;
    let mut request = || {
        if let Some(collation) = collation {
            return Ok(collation);
        }
        let handle = request.take().expect("one first measurement")()?;
        collation = Some(handle);
        Ok(handle)
    };
    scopes
        .iter()
        .map(|scope| {
            let absolute = if scope == "." {
                args.repo_root.clone()
            } else {
                join_path_text(args.repo_root, scope)
            };
            let loaded = load_edge_project_text_request(
                &absolute,
                EdgeScope::Package,
                repo_root,
                None,
                || request(),
            )
            .map_err(CollapseGateError::Load)?;
            let collation = request().map_err(CollapseGateError::Collation)?;
            let graph = assemble_graph_with_analysis_text_and_warning(
                &loaded,
                args.thresholds.clone(),
                binary,
                NodeFields::default(),
                Some(&AnalysisOptions {
                    cross_runtime: true,
                    kinds: true,
                    reach: false,
                    clusters: false,
                    interface_width: false,
                    kind_rules: args.kind_rules,
                    repo_root,
                }),
                None,
                TextAssembly {
                    root: &absolute,
                    warning,
                },
                collation,
            )
            .map_err(CollapseGateError::Assembly)?;
            let candidates = graph
                .functions
                .iter()
                .filter(|function| is_candidate_function(function, args.settings))
                .collect::<Vec<_>>();
            Ok(ScopeCount {
                scope: scope.clone(),
                count: find_partial_twins(&candidates, args.settings, collation)
                    .map_err(CollapseGateError::Collation)?
                    .len() as f64,
            })
        })
        .collect()
}

pub(crate) fn run_collapse_gate<'c>(
    args: CollapseGateArgs<'_>,
    binary: &TsgoBinary,
    warning: &mut dyn FnMut(&JsString),
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<CollapseGateResult, CollapseGateError> {
    let file = join_path_text(args.repo_root, &CEILINGS_FILENAME.into());
    let ceilings: ScopeCountCeilings =
        match read_scope_ceilings(&file).map_err(CollapseGateError::Record)? {
            ScopeCeilingsResolution::Resolved(ceilings) => ceilings,
            ScopeCeilingsResolution::Refused { message } => {
                return Ok(CollapseGateResult {
                    exit_code: 2,
                    reports: vec![message],
                    emitted: Vec::new(),
                });
            }
        };
    let scope = scope_of(args.repo_root, args.root_absolute).map_err(CollapseGateError::Scope)?;
    if args.write_ceilings {
        let recorded = record_scope_ceilings(
            &measure(
                std::slice::from_ref(&scope),
                &args,
                binary,
                warning,
                request,
            )?,
            &ceilings,
        );
        let bytes = format!(
            "{}\n",
            stable_stringify(&recorded, true).map_err(CollapseGateError::Json)?
        );
        fs::write(file.to_lossy(), bytes).map_err(|source| {
            CollapseGateError::Write(match ApiArgumentError::from_null_path(&file, source) {
                Ok(error) => ApiError::Argument(error),
                Err(source) => ApiError::Io {
                    path: file.clone(),
                    source,
                },
            })
        })?;
        let mut acknowledgement = JsString::from("recorded ");
        acknowledgement.extend(&scope);
        acknowledgement.push_str(" at ");
        acknowledgement.extend(&recorded.ceiling_of(&scope).text());
        acknowledgement.push_str(" partial twin(s) in ");
        acknowledgement.extend(&file);
        acknowledgement.push_str("\n");
        return Ok(CollapseGateResult {
            emitted: vec![acknowledgement],
            ..CollapseGateResult::default()
        });
    }
    let scopes =
        scopes_under_unordered(&ceilings.scopes.keys().cloned().collect::<Vec<_>>(), &scope);
    if scopes.is_empty() {
        let mut message = JsString::from("no scope at or under \"");
        message.extend(&scope);
        message.push_str("\" is recorded in collapse-ceilings.json; record one with `--collapse --write-ceilings` before gating on it.");
        return Ok(CollapseGateResult {
            exit_code: 2,
            reports: vec![message],
            emitted: Vec::new(),
        });
    }
    let collation = request().map_err(CollapseGateError::Collation)?;
    let scopes = order_scopes(scopes, collation).map_err(CollapseGateError::Collation)?;
    let mut rendered = render_partial_twin_ratchet(
        &evaluate_scope_ratchet(
            &measure(&scopes, &args, binary, warning, || Ok(collation))?,
            &ceilings,
            collation,
        )
        .map_err(CollapseGateError::Collation)?,
        args.json,
        args.pretty,
    )
    .map_err(CollapseGateError::Json)?;
    rendered.stdout.push_str("\n");
    Ok(CollapseGateResult {
        exit_code: rendered.exit_code,
        emitted: vec![rendered.stdout],
        reports: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // Write measurement newly needs collation. Its actual load refusal must win
    // before the caller is asked to prepare native state, and leave bytes alone.
    #[test]
    fn write_measurement_load_refusal_precedes_collation_request() {
        struct Scratch(std::path::PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let scratch = Scratch(std::env::temp_dir().join(format!(
            "demlik-collapse-write-admission-{}",
            std::process::id()
        )));
        fs::create_dir(&scratch.0).unwrap();
        let file = scratch.0.join(CEILINGS_FILENAME);
        let bytes = b"{\"default\":0,\"scopes\":{}}\n";
        fs::write(&file, bytes).unwrap();
        let root: JsString = scratch.0.to_str().unwrap().into();
        let requested = Cell::new(0);
        let failure = run_collapse_gate(
            CollapseGateArgs {
                root_absolute: &root,
                repo_root: &root,
                write_ceilings: true,
                thresholds: &Thresholds::default(),
                kind_rules: &NodeKindRules::default(),
                settings: &CollapseSettings::default(),
                json: false,
                pretty: false,
            },
            &TsgoBinary::pinned("/nonexistent/compiler"),
            &mut |_| {},
            || {
                requested.set(requested.get() + 1);
                panic!("collation requested before real load refusal")
            },
        )
        .unwrap_err();
        assert!(matches!(failure, CollapseGateError::Load(_)));
        assert_eq!(requested.get(), 0);
        assert_eq!(fs::read(file).unwrap(), bytes);
    }
}
