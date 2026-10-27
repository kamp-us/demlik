//! Optional report shapes, shared by extraction and graph consumers.
use super::EntryReach;
use crate::text::JsString;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnreachableCategory {
    Dead,
    OnlyCalledFromTests,
}
impl UnreachableCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dead => "dead",
            Self::OnlyCalledFromTests => "only-called-from-tests",
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachableSymbol {
    pub id: String,
    pub file: String,
    pub start_line: usize,
    pub category: UnreachableCategory,
    pub test_references: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WithheldReason {
    ReferencedInNonTestFile,
    PublicEntrySurface,
    TestSupportSurface,
}
impl WithheldReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReferencedInNonTestFile => "referenced-in-non-test-file",
            Self::PublicEntrySurface => "public-entry-surface",
            Self::TestSupportSurface => "test-support-surface",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct WithheldSymbol {
    pub id: String,
    pub reason: WithheldReason,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnguardedEffect {
    pub effect_id: String,
    pub file: String,
    pub start_line: usize,
    pub entry_id: String,
    pub path: Vec<String>,
    pub reach: EntryReach,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachabilityReport {
    pub entry_count: usize,
    pub exported_count: usize,
    pub reachable_count: usize,
    pub unreachable: Vec<UnreachableSymbol>,
    pub withheld: Vec<WithheldSymbol>,
    pub unguarded: Vec<UnguardedEffect>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWidth {
    pub id: String,
    pub name: String,
    pub file: String,
    pub start_line: usize,
    pub external_consumers: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageWidth {
    pub package: String,
    pub export_count: usize,
    pub zero_consumer_count: usize,
    pub exports: Vec<ExportWidth>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceWidthReport {
    pub packages: Vec<PackageWidth>,
    pub total_exports: usize,
    pub total_zero_consumer: usize,
}

#[derive(Debug, Serialize)]
pub struct ClusterFileGroup {
    pub dir: String,
    pub files: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScatteredCluster {
    pub id: String,
    pub size: usize,
    pub dir_count: usize,
    pub dirs: Vec<ClusterFileGroup>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryClusterGroup {
    pub cluster_id: String,
    pub files: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitDirectory {
    pub dir: String,
    pub file_count: usize,
    pub cluster_count: usize,
    pub clusters: Vec<DirectoryClusterGroup>,
    pub isolated_files: Vec<String>,
}
#[derive(Debug, Serialize)]
pub enum ClusterAlgorithm {
    #[serde(rename = "louvain-deterministic")]
    LouvainDeterministic,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterReport {
    pub algorithm: ClusterAlgorithm,
    pub modularity: f64,
    pub cluster_count: usize,
    pub clustered_file_count: usize,
    pub isolated_file_count: usize,
    pub excluded_test_file_count: usize,
    pub scattered_clusters: Vec<ScatteredCluster>,
    pub split_directories: Vec<SplitDirectory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CrossRuntimeReason {
    TargetServiceUnknown,
    TargetNotLoaded,
    AmbiguousTarget,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindingKind {
    Service,
    DurableObject,
    Workflow,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossRuntimeEdge {
    pub binding: JsString,
    pub binding_kind: BindingKind,
    pub caller_id: String,
    pub callee_id: Option<String>,
    pub line: usize,
    pub method: String,
    pub owner_service: JsString,
    pub reason: Option<CrossRuntimeReason>,
    pub target_class: JsString,
    pub target_service: JsString,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingCensusRow {
    pub binding: JsString,
    pub binding_kind: BindingKind,
    pub call_sites: usize,
    pub owner_service: JsString,
    pub target_class: JsString,
    pub target_service: JsString,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossRuntimeReport {
    pub config_files: Vec<String>,
    pub unparsed_configs: Vec<String>,
    pub census: Vec<BindingCensusRow>,
    pub edges: Vec<CrossRuntimeEdge>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataBindingKind {
    D1,
    DurableObject,
    Kv,
    Queue,
    R2,
}
impl DataBindingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::D1 => "d1",
            Self::DurableObject => "durable-object",
            Self::Kv => "kv",
            Self::Queue => "queue",
            Self::R2 => "r2",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataAccess {
    Read,
    Unknown,
    Write,
}
impl DataAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Unknown => "unknown",
            Self::Write => "write",
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSite {
    pub line: usize,
    pub column: usize,
    pub owner_service: JsString,
    pub binding: JsString,
    pub binding_kind: DataBindingKind,
    pub method: Option<JsString>,
    pub access: DataAccess,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEdge {
    #[serde(flatten)]
    pub site: DataSite,
    pub function_id: String,
}
#[derive(Debug, Serialize)]
pub struct UnattributedDataSite {
    #[serde(flatten)]
    pub site: DataSite,
    pub file: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataReport {
    pub config_files: Vec<String>,
    pub unparsed_configs: Vec<String>,
    pub edges: Vec<DataEdge>,
    pub unattributed: Vec<UnattributedDataSite>,
}
