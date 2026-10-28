//! Syntactic environment-key reads and their declared worker configuration.
mod extract;
mod query;
mod read_site_owner;
mod render;

use crate::{
    extract::wrangler_config::CatalogError,
    project::{CollationError, ProjectLoadError},
    text::JsString,
};
pub(crate) use query::load_env_key_report;
pub(crate) use render::render_env_keys;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyFinding {
    pub key: JsString,
    pub service: JsString,
    pub config_file: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredEnvRead {
    pub key: JsString,
    pub file: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub line: f64,
    pub service: JsString,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WithheldEnvKeyReason {
    OccursElsewhereInSource,
    ReadSiteOwnerUnknown,
    ReadSiteOwnerUnparsed,
}
impl WithheldEnvKeyReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OccursElsewhereInSource => "occurs-elsewhere-in-source",
            Self::ReadSiteOwnerUnknown => "read-site-owner-unknown",
            Self::ReadSiteOwnerUnparsed => "read-site-owner-unparsed",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct WithheldEnvKey {
    pub key: JsString,
    pub reason: WithheldEnvKeyReason,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyReport {
    pub declared_unreferenced: Vec<EnvKeyFinding>,
    pub read_not_declared: Vec<UndeclaredEnvRead>,
    pub withheld: Vec<WithheldEnvKey>,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub declared_count: f64,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub read_count: f64,
    pub unparsed_configs: Vec<String>,
}
#[derive(Debug)]
pub enum EnvKeyError {
    Project(ProjectLoadError),
    Catalog(CatalogError),
    Collation(CollationError),
    Render(serde_json::Error),
}
impl EnvKeyError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Catalog(error) => error.name(),
            Self::Project(_) | Self::Render(_) | Self::Collation(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Catalog(error) => error.message(),
            Self::Project(error) => error.to_string().into(),
            Self::Render(error) => error.to_string().into(),
            Self::Collation(error) => error.to_string().into(),
        }
    }
}
impl std::fmt::Display for EnvKeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Project(e) => e.fmt(f),
            Self::Catalog(e) => e.fmt(f),
            Self::Render(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for EnvKeyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Project(e) => e,
            Self::Catalog(e) => e,
            Self::Render(e) => e,
            Self::Collation(e) => e,
        })
    }
}
