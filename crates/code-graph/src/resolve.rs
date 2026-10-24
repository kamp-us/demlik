//! Semantic TypeScript export lookups backed by one lazy native compiler session.

use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde::Serialize;

use crate::engine::tsgo::{TsgoBinary, TypeProgram, TypeSession, open_type_session};
use crate::project::{EdgeScope, absolute_lexical, resolve_edge_ts_config};

pub use crate::engine::tsgo::TsgoError as GraphError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportOrigin {
    pub file: PathBuf,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportDeclaration {
    pub file: PathBuf,
    pub name: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SubpathExport {
    pub subpath: String,
    pub entry: PathBuf,
    pub declaration: ExportDeclaration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnresolvableSubpath {
    pub subpath: String,
    pub given: String,
    pub entry: PathBuf,
    pub unresolvable: UnresolvableReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnresolvableReason {
    #[serde(rename = "missing-entry-file")]
    MissingEntryFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum SubpathAnswer {
    Export(SubpathExport),
    Unresolvable(UnresolvableSubpath),
}

pub type SubpathEntries = IndexMap<String, String>;

pub struct InProcessGraphOptions {
    pub scope: EdgeScope,
    pub repo_root: Option<PathBuf>,
    pub compiler: TsgoBinary,
}

impl InProcessGraphOptions {
    pub fn new(compiler: TsgoBinary) -> Self {
        Self {
            scope: EdgeScope::Package,
            repo_root: None,
            compiler,
        }
    }
}

enum SessionState {
    Idle,
    Open(Box<TypeSession>),
    Disposed,
}

pub struct InProcessGraph {
    config: PathBuf,
    compiler: TsgoBinary,
    state: SessionState,
}

pub fn load_in_process_graph(
    root: &Path,
    options: InProcessGraphOptions,
) -> Result<Option<InProcessGraph>, GraphError> {
    let root = absolute_lexical(root);
    let repo_root = options.repo_root.as_deref().unwrap_or(&root);
    let Ok(config) = resolve_edge_ts_config(&root, options.scope, repo_root) else {
        return Ok(None);
    };
    Ok(Some(InProcessGraph {
        config,
        compiler: options.compiler,
        state: SessionState::Idle,
    }))
}

impl InProcessGraph {
    fn with_program<T>(
        &mut self,
        file: &Path,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<Option<T>, GraphError>,
    ) -> Result<Option<T>, GraphError> {
        if !file.exists() {
            return Ok(None);
        }
        if matches!(self.state, SessionState::Idle) {
            self.state =
                SessionState::Open(Box::new(open_type_session(&self.compiler, &self.config)?));
        }
        match &mut self.state {
            SessionState::Open(session) => session.with_program(file, read),
            SessionState::Disposed => Err(GraphError::Disposed),
            SessionState::Idle => {
                unreachable!("opening a session either installs it or returns an error")
            }
        }
    }

    pub fn resolve_export_origin(
        &mut self,
        from_file: &Path,
        specifier: &str,
        export_name: &str,
    ) -> Result<Option<ExportOrigin>, GraphError> {
        let file = absolute_lexical(from_file);
        self.with_program(&file, |program| {
            Ok(program
                .export_origin(&file, specifier, export_name)?
                .map(|declaration| ExportOrigin {
                    file: declaration.file,
                    name: declaration.name.unwrap_or_else(|| export_name.to_owned()),
                }))
        })
    }

    pub fn resolve_module_export(
        &mut self,
        module_file: &Path,
        export_name: &str,
    ) -> Result<Option<ExportDeclaration>, GraphError> {
        let file = absolute_lexical(module_file);
        self.with_program(&file, |program| {
            Ok(program
                .module_export(&file, export_name)?
                .map(|declaration| ExportDeclaration {
                    file: declaration.file,
                    name: declaration.name.unwrap_or_else(|| export_name.to_owned()),
                    line: declaration.line,
                }))
        })
    }

    pub fn resolve_publishing_subpaths(
        &mut self,
        entries: &SubpathEntries,
        export_name: &str,
    ) -> Result<Vec<SubpathAnswer>, GraphError> {
        let mut answers = Vec::new();
        let mut entries: Vec<_> = entries.iter().collect();
        entries.sort_by(|(left, _), (right, _)| {
            match (property_index(left), property_index(right)) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });
        for (subpath, given) in entries {
            let entry = absolute_lexical(Path::new(given));
            if !entry.exists() {
                answers.push(SubpathAnswer::Unresolvable(UnresolvableSubpath {
                    subpath: subpath.clone(),
                    given: given.clone(),
                    entry,
                    unresolvable: UnresolvableReason::MissingEntryFile,
                }));
            } else if let Some(declaration) = self.resolve_module_export(&entry, export_name)? {
                answers.push(SubpathAnswer::Export(SubpathExport {
                    subpath: subpath.clone(),
                    entry,
                    declaration,
                }));
            }
        }
        Ok(answers)
    }

    pub fn dispose(&mut self) {
        self.state = SessionState::Disposed;
    }
}

fn property_index(name: &str) -> Option<u32> {
    let index = name.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == name).then_some(index)
}
