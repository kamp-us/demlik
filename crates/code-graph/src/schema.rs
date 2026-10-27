//! The serialized graph's owned data model.

use serde::{Deserialize, Serialize};

pub use crate::extract::functions::FunctionKind;
use crate::project::EdgeScope;
pub use crate::syntax::headers::{FunctionHeader, OverloadSignature};
pub use crate::syntax::imports::{ImportEdge, ImportKind as ImportEdgeKind};
use crate::text::JsString;

pub mod reports;
pub use reports::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Thresholds {
    #[serde(deserialize_with = "safe_integer")]
    pub long_function_loc: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub deep_nesting: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub high_complexity: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub big_file_loc: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub high_fan_in: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub deep_call_chain: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub directory_sprawl: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub dependency_cycle: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub cross_boundary_imports: u64,
}

fn safe_integer<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let number = f64::deserialize(deserializer)?;
    if !number.is_finite()
        || number < 0.0
        || number.fract() != 0.0
        || number > 9_007_199_254_740_991.0
    {
        return Err(serde::de::Error::custom(
            "expected a nonnegative JavaScript safe integer",
        ));
    }
    Ok(number as u64)
}

#[derive(Debug)]
pub struct ThresholdError {
    pub field: &'static str,
    pub value: u64,
}
impl std::fmt::Display for ThresholdError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} must be a nonnegative JavaScript safe integer, got {}",
            self.field, self.value
        )
    }
}
impl std::error::Error for ThresholdError {}
impl Thresholds {
    fn fields(&self) -> [(&'static str, u64); 9] {
        [
            ("longFunctionLoc", self.long_function_loc),
            ("deepNesting", self.deep_nesting),
            ("highComplexity", self.high_complexity),
            ("bigFileLoc", self.big_file_loc),
            ("highFanIn", self.high_fan_in),
            ("deepCallChain", self.deep_call_chain),
            ("directorySprawl", self.directory_sprawl),
            ("dependencyCycle", self.dependency_cycle),
            ("crossBoundaryImports", self.cross_boundary_imports),
        ]
    }
    pub fn validate(&self) -> Result<(), ThresholdError> {
        for (field, value) in self.fields() {
            if value > 9_007_199_254_740_991 {
                return Err(ThresholdError { field, value });
            }
        }
        Ok(())
    }
    pub fn parse(value: &crate::text::JsValue) -> Result<Self, crate::validation::InputIssue> {
        use crate::{
            text::JsString,
            validation::{InputIssue, NumberCheck, PathSegment, checked_number},
        };
        let object = value
            .as_object()
            .ok_or_else(|| InputIssue::invalid_type(Vec::new(), "object", Some(value)))?;
        let fields = Self::default().fields();
        for (key, _) in fields {
            if let Some(value) = object.get(&JsString::from(key)) {
                checked_number(
                    value,
                    vec![PathSegment::Field(key.into())],
                    NumberCheck::Integer {
                        minimum: 0.0,
                        maximum: None,
                    },
                )?;
            }
        }
        let unknown = crate::text::object_keys(object)
            .into_iter()
            .filter(|key| !fields.iter().any(|(expected, _)| **key == *expected))
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(InputIssue::unrecognized_keys(Vec::new(), &unknown));
        }
        // Keep transport/default conversion owned by the existing count model.
        Ok(serde_json::from_str(
            &serde_json::to_string(value).expect("validated JSON value serializes"),
        )
        .expect("validated Thresholds match the canonical count transport"))
    }
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            long_function_loc: 60,
            deep_nesting: 4,
            high_complexity: 10,
            big_file_loc: 400,
            high_fan_in: 10,
            deep_call_chain: 5,
            directory_sprawl: 10,
            dependency_cycle: 1,
            cross_boundary_imports: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SmellKind {
    LongFunction,
    DeepNesting,
    HighComplexity,
    DenseUndocumented,
    BigFile,
    HighFanIn,
    DeepCallChain,
    DirectorySprawl,
    DependencyCycle,
    CrossBoundaryImport,
}
impl SmellKind {
    pub const ALL: [Self; 10] = [
        Self::LongFunction,
        Self::DeepNesting,
        Self::HighComplexity,
        Self::DenseUndocumented,
        Self::BigFile,
        Self::HighFanIn,
        Self::DeepCallChain,
        Self::DirectorySprawl,
        Self::DependencyCycle,
        Self::CrossBoundaryImport,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LongFunction => "long-function",
            Self::DeepNesting => "deep-nesting",
            Self::HighComplexity => "high-complexity",
            Self::DenseUndocumented => "dense-undocumented",
            Self::BigFile => "big-file",
            Self::HighFanIn => "high-fan-in",
            Self::DeepCallChain => "deep-call-chain",
            Self::DirectorySprawl => "directory-sprawl",
            Self::DependencyCycle => "dependency-cycle",
            Self::CrossBoundaryImport => "cross-boundary-import",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum SmellTarget {
    Function {
        id: String,
        file: String,
        start_line: usize,
    },
    Module {
        file: String,
    },
    Directory {
        dir: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct Smell {
    pub kind: SmellKind,
    pub target: SmellTarget,
    pub value: usize,
    pub threshold: u64,
    pub severity: Severity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSite {
    pub callee_id: crate::text::JsString,
    pub line: usize,
    pub const_args: Vec<String>,
    pub declaration: Option<crate::text::JsString>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerSite {
    pub caller_id: String,
    pub line: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edges {
    pub calls: Vec<CallSite>,
    pub called_by: Vec<CallerSite>,
    pub call_chain_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryReach {
    Public,
    ServiceBinding,
    Platform,
}
impl EntryReach {
    pub const ALL: [Self; 3] = [Self::Public, Self::ServiceBinding, Self::Platform];
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NodeKind {
    Entry {
        evidence: Vec<crate::text::JsString>,
        guards: Vec<crate::text::JsString>,
        reach: EntryReach,
    },
    Auth {
        evidence: Vec<crate::text::JsString>,
    },
    Effect {
        evidence: Vec<crate::text::JsString>,
    },
    Plain,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionNode {
    pub id: String,
    pub name: String,
    pub kind: FunctionKind,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub loc: usize,
    pub comment_lines: usize,
    pub nesting_depth: usize,
    pub complexity: usize,
    pub is_exported: bool,
    pub is_test: bool,
    pub edges: Option<Edges>,
    pub node_kind: Option<NodeKind>,
    pub smells: Vec<Smell>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<FunctionHeader>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeclarationKind {
    TypeAlias,
    Interface,
    Enum,
    Class,
    Constant,
}
impl DeclarationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeAlias => "type-alias",
            Self::Interface => "interface",
            Self::Enum => "enum",
            Self::Class => "class",
            Self::Constant => "constant",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct UseSite {
    pub file: String,
    pub line: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationNode {
    pub id: String,
    pub name: String,
    pub kind: DeclarationKind,
    pub file: String,
    pub line: usize,
    pub is_exported: bool,
    pub is_test: bool,
    pub uses: Option<Vec<UseSite>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleNode {
    pub file: String,
    pub loc: usize,
    pub comment_lines: usize,
    pub function_ids: Vec<String>,
    pub imports: Vec<crate::text::JsString>,
    pub imported_by: Vec<String>,
    pub import_edges: Vec<ImportEdge>,
    pub is_test: bool,
    pub smells: Vec<Smell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryNode {
    pub dir: String,
    pub file_count: usize,
    pub function_count: usize,
    pub files: Vec<String>,
    pub smells: Vec<Smell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanComponents {
    pub smells: usize,
    pub complexity: usize,
    pub fan_in: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub id: String,
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub score: usize,
    pub components: PlanComponents,
    pub loc: usize,
    pub complexity: usize,
    pub called_by_count: Option<usize>,
    pub smells: Vec<Smell>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "pass",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Provenance {
    Cheap,
    Edges { ts_config: String, scope: EdgeScope },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Healthy,
    Rough,
    Rotten,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub health: Health,
    pub file_count: usize,
    pub function_count: usize,
    pub smell_count: usize,
    pub high_severity_count: usize,
    pub worst_file: Option<String>,
    pub worst_function: Option<String>,
    pub top_targets: Vec<PlanRow>,
    pub parse_failures: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub file_count: usize,
    pub function_count: usize,
    pub total_loc: usize,
    pub total_comment_lines: usize,
    pub smell_count: usize,
    pub parse_failures: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub root: JsString,
    pub provenance: Provenance,
    pub thresholds: Thresholds,
    pub summary: Summary,
    pub cross_runtime: Option<CrossRuntimeReport>,
    pub reachability: Option<ReachabilityReport>,
    pub clusters: Option<ClusterReport>,
    pub interface_width: Option<InterfaceWidthReport>,
    pub data: Option<DataReport>,
    pub functions: Vec<FunctionNode>,
    pub declarations: Vec<DeclarationNode>,
    pub modules: Vec<ModuleNode>,
    pub directories: Vec<DirectoryNode>,
    pub smells: Vec<Smell>,
    pub stats: Stats,
}
