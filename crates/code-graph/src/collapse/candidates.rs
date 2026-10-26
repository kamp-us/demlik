use super::settings::CollapseSettings;
use crate::schema::{FunctionKind, FunctionNode};

pub fn is_candidate_function(function: &FunctionNode, settings: &CollapseSettings) -> bool {
    if function.is_test || function.edges.is_none() {
        return false;
    }
    if matches!(
        function.kind,
        FunctionKind::Constructor | FunctionKind::Getter | FunctionKind::Setter
    ) {
        return false;
    }
    function.loc as f64 >= settings.min_loc && function.complexity as f64 >= settings.min_complexity
}
