//! Direct client for the pinned native TypeScript compiler's Go API.

mod ast;
mod channel;

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use serde::Deserialize;
use serde_json::{Value, json};

use ast::{Node, SourceFile};
use channel::Channel;

pub const NATIVE_PREVIEW_PIN: &str = "7.0.0-dev.20260707.2";

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
    case_sensitive: bool,
    ordinal: u64,
}

pub fn open_type_session(
    binary: &TsgoBinary,
    ts_config_path: &Path,
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
        case_sensitive: initialization.use_case_sensitive_file_names,
        ordinal: 0,
    })
}

impl TypeSession {
    pub fn with_program<T>(
        &mut self,
        file: &Path,
        read: impl FnOnce(&mut TypeProgram<'_>) -> Result<T, TsgoError>,
    ) -> Result<T, TsgoError> {
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
        let config_name = config.to_string_lossy().into_owned();
        let body = serde_json::to_string(
            &json!({ "extends": self.config, "files": [file], "include": [] }),
        )?;
        self.channel.virtual_files.insert(config_name.clone(), body);
        let opened = self
            .channel
            .json("updateSnapshot", json!({ "openProjects": [config] }));
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
            }),
            None => Err(TsgoError::protocol(format!(
                "tsgo opened no project for {config_name}"
            ))),
        };
        let cleanup = self.close_program(snapshot.snapshot, &config);
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

    fn close_program(&mut self, snapshot: u64, config: &Path) -> Result<(), TsgoError> {
        self.channel
            .json("release", json!({ "snapshot": snapshot }))?;
        let closed = self
            .channel
            .json("updateSnapshot", json!({ "closeProjects": [config] }))?;
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
    sources: HashMap<String, Rc<SourceFile>>,
}

impl TypeProgram<'_> {
    fn source_file(&mut self, file: &Path) -> Result<Option<Rc<SourceFile>>, TsgoError> {
        let key = file.to_string_lossy();
        if let Some(source) = self.sources.get(key.as_ref()) {
            return Ok(Some(source.clone()));
        }
        let bytes = self.channel.binary(
            "getSourceFile",
            json!({ "snapshot": self.snapshot, "project": self.project, "file": file }),
        )?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let source = Rc::new(SourceFile::parse(bytes)?);
        self.sources.insert(key.into_owned(), source.clone());
        self.sources.insert(source.path.clone(), source.clone());
        Ok(Some(source))
    }

    fn symbol_at(&mut self, source: &SourceFile, node: Node) -> Result<Option<Symbol>, TsgoError> {
        let value = self.channel.json("getSymbolAtLocation", json!({ "snapshot": self.snapshot, "project": self.project, "location": source.handle(node) }))?;
        Ok(serde_json::from_value(value)?)
    }

    fn exported_declaration(
        &mut self,
        module: Symbol,
        name: &str,
    ) -> Result<Option<Declaration>, TsgoError> {
        let exports: Vec<Symbol> = serde_json::from_value(self.channel.json(
            "getExportsOfModule",
            json!({ "snapshot": self.snapshot, "project": self.project, "symbol": module.id }),
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
            let Some(source) = self.source_file(Path::new(path))? else {
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
        let Some(source) = self.source_file(file)? else {
            return Ok(None);
        };
        let Some(module) = self.symbol_at(&source, source.node(1)?)? else {
            return Ok(None);
        };
        self.exported_declaration(module, name)
    }

    pub fn export_origin(
        &mut self,
        file: &Path,
        specifier: &str,
        name: &str,
    ) -> Result<Option<Declaration>, TsgoError> {
        let Some(source) = self.source_file(file)? else {
            return Ok(None);
        };
        let Some(literal) = source.imported_module(specifier)? else {
            return Ok(None);
        };
        let Some(module) = self.symbol_at(&source, literal)? else {
            return Ok(None);
        };
        self.exported_declaration(module, name)
    }
}
