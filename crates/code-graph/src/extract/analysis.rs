use super::functions::DiscoveredFunction;
use crate::project::locale_compare;
use crate::schema::FunctionNode;
use indexmap::{IndexMap, IndexSet};

pub struct NamedSymbol<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub file: &'a str,
    pub is_exported: bool,
}
impl<'a> From<&'a DiscoveredFunction> for NamedSymbol<'a> {
    fn from(node: &'a DiscoveredFunction) -> Self {
        Self {
            id: &node.id,
            name: &node.name,
            file: &node.file,
            is_exported: node.is_exported,
        }
    }
}
impl<'a> From<&'a FunctionNode> for NamedSymbol<'a> {
    fn from(node: &'a FunctionNode) -> Self {
        Self {
            id: &node.id,
            name: &node.name,
            file: &node.file,
            is_exported: node.is_exported,
        }
    }
}
pub struct AnalysisInputs {
    pub names: IndexSet<String>,
    pub exports_by_file: IndexMap<String, Vec<String>>,
}
pub fn analysis_inputs<'a>(functions: impl IntoIterator<Item = NamedSymbol<'a>>) -> AnalysisInputs {
    let mut names = IndexSet::new();
    let mut exports_by_file: IndexMap<String, Vec<String>> = IndexMap::new();
    for node in functions {
        names.insert(node.name.into());
        if node.is_exported {
            exports_by_file
                .entry(node.file.into())
                .or_default()
                .push(node.id.into());
        }
    }
    for exports in exports_by_file.values_mut() {
        exports.sort_by(|left, right| locale_compare(left, right));
    }
    AnalysisInputs {
        names,
        exports_by_file,
    }
}
