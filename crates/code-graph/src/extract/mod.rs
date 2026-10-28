//! Structural graph extraction from parsed source files.

pub mod analysis;
pub mod assemble;
pub mod callee;
pub mod chain_depth;
pub mod conventions;
pub mod cross_runtime;
pub mod directories;
pub mod edges;
pub mod functions;
pub mod metrics;
pub mod package_exports;
pub mod references;
pub mod scc;
pub mod wrangler_config;

#[derive(Debug)]
pub enum ResolveError {
    Compiler(crate::engine::tsgo::TsgoError),
    Collation(crate::project::CollationError),
}
impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Compiler(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for ResolveError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Compiler(e) => e,
            Self::Collation(e) => e,
        })
    }
}
impl From<crate::engine::tsgo::TsgoError> for ResolveError {
    fn from(error: crate::engine::tsgo::TsgoError) -> Self {
        Self::Compiler(error)
    }
}
impl From<crate::project::CollationError> for ResolveError {
    fn from(error: crate::project::CollationError) -> Self {
        Self::Collation(error)
    }
}
