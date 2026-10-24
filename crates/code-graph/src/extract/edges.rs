use crate::schema::CallerSite;
use std::collections::HashSet;

pub fn distinct_external_callers(id: &str, called_by: &[CallerSite]) -> usize {
    called_by
        .iter()
        .filter(|caller| caller.caller_id != id)
        .map(|caller| caller.caller_id.as_str())
        .collect::<HashSet<_>>()
        .len()
}
pub fn self_recursive_call_count(id: &str, called_by: &[CallerSite]) -> usize {
    called_by
        .iter()
        .filter(|caller| caller.caller_id == id)
        .count()
}
