//! OXC module resolution using the same pinned engine and options as TypeScript.

mod parser;
pub use parser::{ParseFailure, parse_type_script};

use std::path::{Path, PathBuf};

pub use oxc_resolver::ResolveError;
use oxc_resolver::{
    ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};

pub fn parse_snippet(text: &str) -> Result<Option<crate::syntax::file::SyntaxFile>, ParseFailure> {
    match parse_type_script(Path::new("snippet.tsx"), text) {
        Ok(syntax) => Ok(Some(syntax)),
        Err(ParseFailure::Syntax(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

fn module_resolution() -> ResolveOptions {
    ResolveOptions {
        extensions: [
            ".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json",
        ]
        .map(str::to_owned)
        .into(),
        extension_alias: [
            (".js", &[".ts", ".tsx", ".d.ts", ".js"][..]),
            (".jsx", &[".tsx", ".jsx"][..]),
            (".mjs", &[".mts", ".mjs"][..]),
            (".cjs", &[".cts", ".cjs"][..]),
        ]
        .into_iter()
        .map(|(extension, aliases)| {
            (
                extension.to_owned(),
                aliases.iter().map(|alias| (*alias).to_owned()).collect(),
            )
        })
        .collect(),
        condition_names: ["types", "import", "node", "default"]
            .map(str::to_owned)
            .into(),
        ..ResolveOptions::default()
    }
}

pub struct ModuleResolver {
    resolver: Resolver,
}

pub fn create_module_resolver(ts_config_path: &Path) -> ModuleResolver {
    ModuleResolver {
        resolver: Resolver::new(ResolveOptions {
            tsconfig: Some(TsconfigDiscovery::Manual(TsconfigOptions {
                config_file: ts_config_path.to_path_buf(),
                references: TsconfigReferences::Disabled,
            })),
            ..module_resolution()
        }),
    }
}

impl ModuleResolver {
    /// TypeScript-compatible path-or-missing facade.
    pub fn resolve(&self, from_file: &Path, specifier: &str) -> Option<PathBuf> {
        self.resolve_detailed(from_file, specifier).ok()
    }

    /// Native diagnostics retain configuration, package-export, and missing-module failures.
    pub fn resolve_detailed(
        &self,
        from_file: &Path,
        specifier: &str,
    ) -> Result<PathBuf, ResolveError> {
        self.resolver
            .resolve(from_file.parent().unwrap_or(from_file), specifier)
            .map(|resolved| resolved.path().to_path_buf())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileResolution {
    Path(PathBuf),
    Builtin,
    Missing,
}

pub struct NearestTsconfigResolver {
    resolver: Resolver,
}

pub fn create_nearest_tsconfig_resolver() -> NearestTsconfigResolver {
    NearestTsconfigResolver {
        resolver: Resolver::new(ResolveOptions {
            tsconfig: Some(TsconfigDiscovery::Auto),
            builtin_modules: true,
            ..module_resolution()
        }),
    }
}

impl NearestTsconfigResolver {
    pub fn resolve(&self, from_file: &Path, specifier: &str) -> FileResolution {
        match self.resolve_detailed(from_file, specifier) {
            Ok(path) => FileResolution::Path(path),
            Err(ResolveError::Builtin { .. }) => FileResolution::Builtin,
            Err(_) => FileResolution::Missing,
        }
    }

    pub fn resolve_detailed(
        &self,
        from_file: &Path,
        specifier: &str,
    ) -> Result<PathBuf, ResolveError> {
        self.resolver
            .resolve_file(from_file, specifier)
            .map(|resolved| resolved.path().to_path_buf())
    }

    /// Directory resolution intentionally does not apply automatic tsconfig discovery.
    pub fn locate(&self, from_directory: &Path, specifier: &str) -> Option<PathBuf> {
        self.locate_detailed(from_directory, specifier).ok()
    }

    pub fn locate_detailed(
        &self,
        from_directory: &Path,
        specifier: &str,
    ) -> Result<PathBuf, ResolveError> {
        self.resolver
            .resolve(from_directory, specifier)
            .map(|resolved| resolved.path().to_path_buf())
    }
}
