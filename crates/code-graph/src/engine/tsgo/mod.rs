//! Direct client for the pinned native TypeScript compiler's Go API.

mod ast;
mod channel;
mod tree;
pub(crate) use ast::{conflict_marker, conflict_marker_end, line_break};
pub use tree::{NativeFile, NativeNode, NativeSymbol};

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use crate::{
    project::{dirname_path_text, join_path_text},
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use ast::{Node, SourceFile};
use channel::Channel;

pub const NATIVE_PREVIEW_PIN: &str = "7.0.0-dev.20260707.2";
pub(crate) fn native_kind(name: &str) -> u32 {
    ast::kind_named(name).expect("pinned compiler defines the requested syntax kind")
}
pub(crate) fn native_flag(name: &str) -> u32 {
    ast::flag_named(name).expect("pinned compiler defines the requested node flag")
}

#[derive(Debug)]
pub enum TsgoError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Protocol(String),
    Dependency(String),
    Compiler {
        method: String,
        message: String,
    },
    VersionMismatch {
        expected: String,
        actual: String,
    },
    OperationAndCleanup {
        operation: Box<Self>,
        cleanup: Box<Self>,
    },
    Disposed,
}

impl TsgoError {
    fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol(message.into())
    }
}

impl fmt::Display for TsgoError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "code-graph: native compiler I/O: {error}"),
            Self::Json(error) => write!(formatter, "code-graph: native compiler JSON: {error}"),
            Self::Protocol(message) | Self::Dependency(message) => {
                write!(formatter, "code-graph: {message}")
            }
            Self::Compiler { message, .. } => formatter.write_str(message),
            Self::VersionMismatch { expected, actual } => write!(
                formatter,
                "code-graph: native compiler version mismatch, expected {expected}, received {actual}"
            ),
            Self::OperationAndCleanup { operation, cleanup } => write!(
                formatter,
                "{operation}; compiler cleanup also failed: {cleanup}"
            ),
            Self::Disposed => {
                formatter.write_str("code-graph: lookup called on a disposed InProcessGraph")
            }
        }
    }
}

impl std::error::Error for TsgoError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::OperationAndCleanup { operation, .. } => Some(operation.as_ref()),
            _ => None,
        }
    }
}
impl From<std::io::Error> for TsgoError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for TsgoError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Debug, Clone)]
pub struct TsgoBinary {
    path: PathBuf,
    version: String,
}

impl TsgoBinary {
    /// Explicit binary configuration remains lazy until the first real program lookup.
    pub fn pinned(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            version: NATIVE_PREVIEW_PIN.into(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Locate the platform binary installed with the existing native-preview dependency.
    pub fn from_native_preview_manifest(manifest: &Path) -> Result<Self, TsgoError> {
        let manifest = fs::canonicalize(manifest)?;
        let package: Value = serde_json::from_slice(&fs::read(&manifest)?)?;
        if package["name"] != "@typescript/native-preview" {
            return Err(TsgoError::Dependency(
                "expected an @typescript/native-preview package manifest".into(),
            ));
        }
        let version = package["version"].as_str().ok_or_else(|| {
            TsgoError::Dependency("native-preview manifest has no version".into())
        })?;
        if version != NATIVE_PREVIEW_PIN {
            return Err(TsgoError::VersionMismatch {
                expected: NATIVE_PREVIEW_PIN.into(),
                actual: version.into(),
            });
        }
        if !package["bin"]
            .as_object()
            .is_some_and(|bins| bins.len() == 1 && bins.contains_key("tsgo"))
        {
            return Err(TsgoError::Dependency(
                "native-preview must declare exactly one tsgo binary".into(),
            ));
        }
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            "linux" => "linux",
            platform => {
                return Err(TsgoError::Dependency(format!(
                    "unsupported native compiler platform {platform}"
                )));
            }
        };
        let architecture = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            architecture => {
                return Err(TsgoError::Dependency(format!(
                    "unsupported native compiler architecture {architecture}"
                )));
            }
        };
        let dependency =
            format!("@typescript/native-preview-{platform}-{architecture}/package.json");
        let directory = manifest.parent().ok_or_else(|| {
            TsgoError::Dependency("native-preview manifest has no parent directory".into())
        })?;
        let resolved = super::oxc::create_nearest_tsconfig_resolver()
            .locate_detailed(directory, &dependency)
            .map_err(|error| {
                TsgoError::Dependency(format!(
                    "cannot locate native compiler dependency {dependency}: {error}"
                ))
            })?;
        let native: Value = serde_json::from_slice(&fs::read(&resolved)?)?;
        if native["version"] != version {
            return Err(TsgoError::Dependency(
                "native compiler and native-preview manifest versions differ".into(),
            ));
        }
        let binary = resolved
            .parent()
            .ok_or_else(|| {
                TsgoError::Dependency("native compiler manifest has no parent directory".into())
            })?
            .join("lib")
            .join(if cfg!(windows) { "tsgo.exe" } else { "tsgo" });
        if !binary.is_file() {
            return Err(TsgoError::Dependency(format!(
                "native compiler executable is missing: {}",
                binary.display()
            )));
        }
        Ok(Self {
            path: binary,
            version: version.into(),
        })
    }

    fn validate(&self) -> Result<(), TsgoError> {
        let output = Command::new(&self.path).arg("--version").output()?;
        let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !output.status.success() || actual != format!("Version {}", self.version) {
            return Err(TsgoError::VersionMismatch {
                expected: format!("Version {}", self.version),
                actual: format!("{actual} {}", String::from_utf8_lossy(&output.stderr))
                    .trim()
                    .to_owned(),
            });
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Initialization {
    use_case_sensitive_file_names: bool,
}

#[derive(Deserialize)]
struct Snapshot {
    snapshot: u64,
    projects: Vec<Project>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    config_file_name: String,
    compiler_options: Value,
}

#[derive(Deserialize)]
struct Symbol {
    id: u64,
    name: String,
    flags: u32,
    #[serde(default)]
    declarations: Vec<String>,
}

impl Symbol {
    fn display_name(&self) -> &str {
        if self.name.starts_with("___") {
            &self.name[1..]
        } else {
            &self.name
        }
    }
}

pub struct Declaration {
    pub file: PathBuf,
    pub name: Option<String>,
    pub line: usize,
}

pub struct TypeSession {
    channel: Channel,
    config: PathBuf,
    config_text: Option<JsString>,
    case_sensitive: bool,
    ordinal: u64,
}

pub struct ProgramInput<'a> {
    pub root_files: &'a [PathBuf],
    pub include_config_files: bool,
}
pub struct TextProgramInput<'a> {
    pub root_files: &'a [JsString],
    pub include_config_files: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFiles {
    file_names: Vec<PathBuf>,
}

pub fn open_type_session(
    binary: &TsgoBinary,
    ts_config_path: &Path,
) -> Result<TypeSession, TsgoError> {
    open_type_session_in(binary, ts_config_path, None)
}

pub fn open_type_session_text(
    binary: &TsgoBinary,
    ts_config_path: &JsString,
) -> Result<TypeSession, TsgoError> {
    open_type_session_in(
        binary,
        Path::new(&ts_config_path.to_lossy()),
        Some(ts_config_path.clone()),
    )
}
fn open_type_session_in(
    binary: &TsgoBinary,
    ts_config_path: &Path,
    config_text: Option<JsString>,
) -> Result<TypeSession, TsgoError> {
    let directory = ts_config_path
        .parent()
        .ok_or_else(|| TsgoError::protocol("tsconfig has no parent directory"))?;
    let mut channel = Channel::open(binary, directory)?;
    let initialization: Initialization =
        serde_json::from_value(channel.json("initialize", Value::Null)?)?;
    Ok(TypeSession {
        channel,
        config: ts_config_path.to_path_buf(),
        config_text,
        case_sensitive: initialization.use_case_sensitive_file_names,
        ordinal: 0,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum ProjectUpdate<'a> {
    OpenProjects([&'a JsString; 1]),
    CloseProjects([&'a JsString; 1]),
}
#[derive(Serialize)]
struct ConfigFile<'a> {
    file: &'a JsString,
}
#[derive(Serialize)]
struct VirtualConfig<'a, F: ?Sized> {
    extends: &'a JsString,
    files: &'a F,
    include: [(); 0],
}
impl TypeSession {
    pub fn with_program<T>(
        &mut self,
        file: &Path,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<T, TsgoError>,
    ) -> Result<T, TsgoError> {
        self.with_compilation(
            ProgramInput {
                root_files: &[file.to_path_buf()],
                include_config_files: false,
            },
            read,
        )
    }

    pub fn with_compilation<T>(
        &mut self,
        input: ProgramInput<'_>,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<T, TsgoError>,
    ) -> Result<T, TsgoError> {
        let mut files = self.config_files(input.include_config_files)?;
        files.extend_from_slice(input.root_files);
        files.sort_by(|left, right| {
            left.to_string_lossy()
                .encode_utf16()
                .cmp(right.to_string_lossy().encode_utf16())
        });
        files.dedup();
        self.with_files(&files, read)
    }

    pub fn with_compilation_text<T>(
        &mut self,
        input: TextProgramInput<'_>,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<T, TsgoError>,
    ) -> Result<T, TsgoError> {
        let mut files = self
            .config_files(input.include_config_files)?
            .into_iter()
            .map(|file| JsString::from(file.to_string_lossy().as_ref()))
            .collect::<Vec<_>>();
        files.extend_from_slice(input.root_files);
        files.sort();
        files.dedup();
        self.with_files(&files, read)
    }

    fn source_config_text(&self) -> JsString {
        self.config_text
            .clone()
            .unwrap_or_else(|| self.config.to_string_lossy().as_ref().into())
    }
    fn config_files(&mut self, include: bool) -> Result<Vec<PathBuf>, TsgoError> {
        if !include {
            return Ok(Vec::new());
        }
        Ok(serde_json::from_value::<ConfigFiles>(self.channel.json(
            "parseConfigFile",
            ConfigFile {
                file: &self.source_config_text(),
            },
        )?)?
        .file_names)
    }
    fn with_files<T, F: Serialize + ?Sized>(
        &mut self,
        files: &F,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<T, TsgoError>,
    ) -> Result<T, TsgoError> {
        let source_config = self.source_config_text();
        let config = self
            .config
            .parent()
            .ok_or_else(|| TsgoError::protocol("tsconfig has no parent directory"))?
            .join(format!(
                ".code-graph-{}-{}.tsconfig.json",
                std::process::id(),
                self.ordinal
            ));
        self.ordinal += 1;
        let config_text = match &self.config_text {
            None => config.to_string_lossy().as_ref().into(),
            Some(raw) => join_path_text(
                &dirname_path_text(raw),
                &config
                    .file_name()
                    .expect("virtual config name")
                    .to_string_lossy()
                    .as_ref()
                    .into(),
            ),
        };
        let config_name = config_text.to_lossy();
        let body = serde_json::to_string(&VirtualConfig {
            extends: &source_config,
            files,
            include: [],
        })?;
        self.channel.virtual_files.insert(config_name.clone(), body);
        let opened = self.channel.json(
            "updateSnapshot",
            ProjectUpdate::OpenProjects([&config_text]),
        );
        let snapshot: Snapshot = match opened.and_then(|value| Ok(serde_json::from_value(value)?)) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.channel.virtual_files.remove(&config_name);
                return Err(error);
            }
        };
        let selected = snapshot.projects.into_iter().find(|project| {
            same_path(&project.config_file_name, &config_name, self.case_sensitive)
        });
        let result = match selected {
            Some(project) => read(&mut TypeProgram {
                channel: &mut self.channel,
                snapshot: snapshot.snapshot,
                project: project.id,
                sources: HashMap::new(),
                owner: Rc::new(()),
                symbols: HashMap::new(),
                compiler_options: project.compiler_options,
                root_libraries: None,
                library_kinds: HashMap::new(),
                declaration_nodes: HashMap::new(),
            }),
            None => Err(TsgoError::protocol(format!(
                "tsgo opened no project for {config_name}"
            ))),
        };
        let cleanup = self.close_program(snapshot.snapshot, &config_text);
        self.channel.virtual_files.remove(&config_name);
        match (result, cleanup) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
            (Err(operation), Err(cleanup)) => Err(TsgoError::OperationAndCleanup {
                operation: Box::new(operation),
                cleanup: Box::new(cleanup),
            }),
        }
    }

    fn close_program(&mut self, snapshot: u64, config: &JsString) -> Result<(), TsgoError> {
        self.channel
            .json("release", json!({ "snapshot": snapshot }))?;
        let closed = self
            .channel
            .json("updateSnapshot", ProjectUpdate::CloseProjects([config]))?;
        let snapshot = closed["snapshot"]
            .as_u64()
            .ok_or_else(|| TsgoError::protocol("closeProjects returned no snapshot"))?;
        self.channel
            .json("release", json!({ "snapshot": snapshot }))?;
        Ok(())
    }
}

fn same_path(left: &str, right: &str, case_sensitive: bool) -> bool {
    let left = if cfg!(windows) {
        left.replace('\\', "/")
    } else {
        left.into()
    };
    let right = if cfg!(windows) {
        right.replace('\\', "/")
    } else {
        right.into()
    };
    if case_sensitive {
        left == right
    } else {
        left.to_lowercase() == right.to_lowercase()
    }
}

pub struct TypeProgram<'a> {
    channel: &'a mut Channel,
    snapshot: u64,
    project: String,
    sources: HashMap<JsString, Rc<SourceFile>>,
    owner: Rc<()>,
    symbols: HashMap<u64, Rc<RefCell<Symbol>>>,
    compiler_options: Value,
    root_libraries: Option<HashSet<String>>,
    library_kinds: HashMap<String, Option<LibraryKind>>,
    declaration_nodes: HashMap<u64, Vec<NativeNode>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryKind {
    Root,
    Referenced,
}

#[derive(Serialize)]
struct SourceFileRequest<'a, F> {
    snapshot: u64,
    project: &'a str,
    file: F,
}

impl TypeProgram<'_> {
    pub fn source_file(&mut self, file: &Path) -> Result<Option<NativeFile>, TsgoError> {
        Ok(self.source_data(file)?.map(|source| NativeFile {
            source,
            owner: self.owner.clone(),
        }))
    }
    pub fn source_file_text(&mut self, file: &JsString) -> Result<Option<NativeFile>, TsgoError> {
        Ok(self.source_data_text(file)?.map(|source| NativeFile {
            source,
            owner: self.owner.clone(),
        }))
    }
    fn check_node(&self, node: &NativeNode) -> Result<(), TsgoError> {
        if node.belongs_to(&self.owner) {
            Ok(())
        } else {
            Err(TsgoError::protocol(
                "native AST node belongs to a different compilation",
            ))
        }
    }
    fn check_symbol(&self, symbol: &NativeSymbol) -> Result<(), TsgoError> {
        if Rc::ptr_eq(&self.owner, &symbol.owner) {
            Ok(())
        } else {
            Err(TsgoError::protocol(
                "native symbol belongs to a different compilation",
            ))
        }
    }
    fn record_symbol(&mut self, symbol: Symbol) -> NativeSymbol {
        let data = if let Some(held) = self.symbols.get(&symbol.id) {
            held.replace(symbol);
            held.clone()
        } else {
            let id = symbol.id;
            let data = Rc::new(RefCell::new(symbol));
            self.symbols.insert(id, data.clone());
            data
        };
        NativeSymbol {
            owner: self.owner.clone(),
            data,
        }
    }
    pub fn symbol_at(&mut self, node: &NativeNode) -> Result<Option<NativeSymbol>, TsgoError> {
        self.check_node(node)?;
        let symbol = self.raw_symbol_at(&node.file.source, node.node)?;
        Ok(symbol.map(|symbol| self.record_symbol(symbol)))
    }
    pub fn symbols_at(
        &mut self,
        nodes: &[NativeNode],
    ) -> Result<Vec<Option<NativeSymbol>>, TsgoError> {
        if nodes.is_empty() {
            return Ok(Vec::new());
        }
        for node in nodes {
            self.check_node(node)?;
        }
        let symbols: Vec<Option<Symbol>> = serde_json::from_value(self.channel.json("getSymbolsAtLocations", json!({ "snapshot": self.snapshot, "project": self.project, "locations": nodes.iter().map(NativeNode::id).collect::<Vec<_>>() }))?)?;
        if symbols.len() != nodes.len() {
            return Err(TsgoError::protocol(
                "native symbol batch returned the wrong result count",
            ));
        }
        Ok(symbols
            .into_iter()
            .map(|symbol| symbol.map(|symbol| self.record_symbol(symbol)))
            .collect())
    }
    pub fn alias_target(
        &mut self,
        symbol: &NativeSymbol,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        self.check_symbol(symbol)?;
        if symbol.flags() & 2_097_152 == 0 {
            return Ok(None);
        }
        let id = symbol.data.borrow().id;
        let target: Option<Symbol> = serde_json::from_value(self.channel.json(
            "getAliasedSymbol",
            json!({ "snapshot": self.snapshot, "project": self.project, "symbol": id }),
        )?)?;
        Ok(target.map(|symbol| self.record_symbol(symbol)))
    }
    pub fn shorthand_value_symbol(
        &mut self,
        node: &NativeNode,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        self.check_node(node)?;
        let symbol: Option<Symbol> = serde_json::from_value(self.channel.json(
            "getShorthandAssignmentValueSymbol",
            json!({ "snapshot": self.snapshot, "project": self.project, "location": node.id() }),
        )?)?;
        Ok(symbol.map(|symbol| self.record_symbol(symbol)))
    }
    pub fn declarations(&mut self, symbol: &NativeSymbol) -> Result<Vec<NativeNode>, TsgoError> {
        self.check_symbol(symbol)?;
        let id = symbol.data.borrow().id;
        if let Some(declarations) = self.declaration_nodes.get(&id) {
            return Ok(declarations.clone());
        }
        let handles = symbol.data.borrow().declarations.clone();
        let mut declarations = Vec::new();
        for handle in handles {
            let mut parts = handle.splitn(3, '.');
            let index: u32 = parts
                .next()
                .and_then(|part| part.parse().ok())
                .ok_or_else(|| {
                    TsgoError::protocol("native declaration handle has an invalid index")
                })?;
            let kind: u32 = parts
                .next()
                .and_then(|part| part.parse().ok())
                .ok_or_else(|| {
                    TsgoError::protocol("native declaration handle has an invalid kind")
                })?;
            let path = parts.next().ok_or_else(|| {
                TsgoError::protocol("native declaration handle has no source path")
            })?;
            let Some(file) = self.source_file(Path::new(path))? else {
                continue;
            };
            let node = file.source.node(index)?;
            if node.kind != kind {
                return Err(TsgoError::protocol(
                    "native declaration handle kind does not match its AST node",
                ));
            }
            declarations.push(NativeNode { file, node });
        }
        self.declaration_nodes.insert(id, declarations.clone());
        Ok(declarations)
    }
    pub fn exports_of(
        &mut self,
        symbol: &NativeSymbol,
    ) -> Result<indexmap::IndexMap<String, NativeSymbol>, TsgoError> {
        self.check_symbol(symbol)?;
        let id = symbol.data.borrow().id;
        let symbols: Vec<Symbol> = serde_json::from_value(self.channel.json(
            "getExportsOfModule",
            json!({ "snapshot": self.snapshot, "project": self.project, "symbol": id }),
        )?)?;
        Ok(symbols
            .into_iter()
            .map(|symbol| {
                let symbol = self.record_symbol(symbol);
                (symbol.name(), symbol)
            })
            .collect())
    }
    pub fn source_file_names(&mut self) -> Result<Vec<PathBuf>, TsgoError> {
        let names: Option<Vec<PathBuf>> = serde_json::from_value(self.channel.json(
            "getSourceFileNames",
            json!({ "snapshot": self.snapshot, "project": self.project }),
        )?)?;
        Ok(names.unwrap_or_default())
    }
    pub fn library_kind(&mut self, file: &NativeFile) -> Result<Option<LibraryKind>, TsgoError> {
        if !Rc::ptr_eq(&file.owner, &self.owner) {
            return Err(TsgoError::protocol(
                "native source file belongs to a different compilation",
            ));
        }
        if let Some(kind) = self.library_kinds.get(&file.source.path) {
            return Ok(*kind);
        }
        if self.root_libraries.is_none() {
            let named = self
                .compiler_options
                .get("lib")
                .map(|names| serde_json::from_value::<Vec<String>>(names.clone()))
                .transpose()?;
            let roots = if let Some(named) = named {
                named.into_iter().map(|name| name.to_lowercase()).collect()
            } else {
                self.source_file_names()?
                    .into_iter()
                    .filter_map(|file| {
                        file.file_name()
                            .map(|name| name.to_string_lossy().to_lowercase())
                    })
                    .filter(|name| {
                        let Some(middle) = name
                            .strip_prefix("lib.")
                            .and_then(|name| name.strip_suffix(".ts"))
                        else {
                            return false;
                        };
                        matches!(middle, "d" | "es6")
                            || middle.strip_suffix(".full.d").is_some_and(|target| {
                                !target.is_empty()
                                    && target.chars().all(|character| {
                                        character.is_ascii_lowercase() || character.is_ascii_digit()
                                    })
                            })
                    })
                    .collect()
            };
            self.root_libraries = Some(roots);
        }
        let metadata = self.channel.json(
            "getSourceFileMetadata",
            json!({ "snapshot": self.snapshot, "project": self.project, "file": file.source.path }),
        )?;
        let kind = if metadata
            .get("isDefaultLibrary")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let name = file
                .file_name()
                .file_name()
                .ok_or_else(|| TsgoError::protocol("native source has no file name"))?
                .to_string_lossy()
                .to_lowercase();
            Some(
                if self
                    .root_libraries
                    .as_ref()
                    .expect("root libraries initialized")
                    .contains(&name)
                {
                    LibraryKind::Root
                } else {
                    LibraryKind::Referenced
                },
            )
        } else {
            None
        };
        self.library_kinds.insert(file.source.path.clone(), kind);
        Ok(kind)
    }

    fn source_data(&mut self, file: &Path) -> Result<Option<Rc<SourceFile>>, TsgoError> {
        self.source_data_request(file.to_string_lossy().as_ref().into(), file)
    }
    fn source_data_text(&mut self, file: &JsString) -> Result<Option<Rc<SourceFile>>, TsgoError> {
        self.source_data_request(file.clone(), file)
    }
    fn source_data_request(
        &mut self,
        key: JsString,
        file: impl Serialize,
    ) -> Result<Option<Rc<SourceFile>>, TsgoError> {
        if let Some(source) = self.sources.get(&key) {
            return Ok(Some(source.clone()));
        }
        let bytes = self.channel.binary(
            "getSourceFile",
            SourceFileRequest {
                snapshot: self.snapshot,
                project: &self.project,
                file,
            },
        )?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let source = Rc::new(SourceFile::parse(bytes)?);
        self.sources.insert(key, source.clone());
        self.sources
            .insert(source.path.clone().into(), source.clone());
        Ok(Some(source))
    }

    fn raw_symbol_at(
        &mut self,
        source: &SourceFile,
        node: Node,
    ) -> Result<Option<Symbol>, TsgoError> {
        let value = self.channel.json("getSymbolAtLocation", json!({ "snapshot": self.snapshot, "project": self.project, "location": source.handle(node) }))?;
        Ok(serde_json::from_value(value)?)
    }

    fn exported_declaration(
        &mut self,
        module: u64,
        name: &str,
    ) -> Result<Option<Declaration>, TsgoError> {
        let exports: Vec<Symbol> = serde_json::from_value(self.channel.json(
            "getExportsOfModule",
            json!({ "snapshot": self.snapshot, "project": self.project, "symbol": module }),
        )?)?;
        let Some(symbol) = exports
            .into_iter()
            .find(|symbol| symbol.display_name() == name)
        else {
            return Ok(None);
        };
        let symbol: Symbol = if symbol.flags & 2_097_152 != 0 {
            serde_json::from_value(self.channel.json(
                "getAliasedSymbol",
                json!({ "snapshot": self.snapshot, "project": self.project, "symbol": symbol.id }),
            )?)?
        } else {
            symbol
        };
        for handle in symbol.declarations {
            let mut parts = handle.splitn(3, '.');
            let index: u32 = parts
                .next()
                .ok_or_else(|| TsgoError::protocol("declaration handle has no node index"))?
                .parse()
                .map_err(|_| TsgoError::protocol("declaration handle has an invalid node index"))?;
            let _kind: u32 = parts
                .next()
                .ok_or_else(|| TsgoError::protocol("declaration handle has no node kind"))?
                .parse()
                .map_err(|_| TsgoError::protocol("declaration handle has an invalid node kind"))?;
            let path = parts
                .next()
                .ok_or_else(|| TsgoError::protocol("declaration handle has no source path"))?;
            let Some(source) = self.source_data(Path::new(path))? else {
                continue;
            };
            let declaration = source.node(index)?;
            return Ok(Some(Declaration {
                file: source.file_name.clone(),
                name: source.declared_name(declaration)?,
                line: source.declaration_line(declaration)?,
            }));
        }
        Ok(None)
    }

    pub fn module_export(
        &mut self,
        file: &Path,
        name: &str,
    ) -> Result<Option<Declaration>, TsgoError> {
        let Some(module) = self.module_symbol_of(file)? else {
            return Ok(None);
        };
        let id = module.data.borrow().id;
        self.exported_declaration(id, name)
    }

    pub fn module_symbol_of(&mut self, file: &Path) -> Result<Option<NativeSymbol>, TsgoError> {
        let file = self.source_file(file)?;
        self.module_symbol(file)
    }
    pub fn module_symbol_of_text(
        &mut self,
        file: &JsString,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        let file = self.source_file_text(file)?;
        self.module_symbol(file)
    }
    fn module_symbol(
        &mut self,
        file: Option<NativeFile>,
    ) -> Result<Option<NativeSymbol>, TsgoError> {
        let Some(file) = file else {
            return Ok(None);
        };
        self.symbol_at(&file.root())
    }

    pub fn export_origin(
        &mut self,
        file: &Path,
        specifier: &str,
        name: &str,
    ) -> Result<Option<Declaration>, TsgoError> {
        let Some(source) = self.source_data(file)? else {
            return Ok(None);
        };
        let Some(literal) = source.imported_module(specifier)? else {
            return Ok(None);
        };
        let Some(module) = self.raw_symbol_at(&source, literal)? else {
            return Ok(None);
        };
        self.exported_declaration(module.id, name)
    }
}
