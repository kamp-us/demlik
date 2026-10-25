mod published;
use super::model::{AddedName, ApiEntryText, ChangedName, RemovedName, SubpathDiff, SubpathNames};
use crate::text::{JsString, object_keys};
pub use published::{
    BaseMapRequest, BaseMapStep, diff_published_api_blocking,
    prepare_api_diff_with_base_map_blocking,
};
use std::sync::Arc;
fn same_entry(before: &ApiEntryText, after: &ApiEntryText) -> bool {
    before.text == after.text
        && before.references.len() == after.references.len()
        && before
            .references
            .iter()
            .all(|(key, value)| after.references.get(key) == Some(value))
}
pub fn diff_subpath_names(
    tier: Option<&JsString>,
    before: &SubpathNames,
    after: &SubpathNames,
) -> SubpathDiff {
    let mut diff = SubpathDiff::new(tier.cloned());
    for name in object_keys(&after.entries) {
        let now = &after.entries[name];
        match before.entries.get(name) {
            None => diff.assign_added(
                name.clone(),
                AddedName {
                    after: Arc::clone(now),
                },
            ),
            Some(then) if !same_entry(then, now) => diff.assign_changed(
                name.clone(),
                ChangedName {
                    before: Arc::clone(then),
                    after: Arc::clone(now),
                },
            ),
            _ => {}
        }
    }
    for name in object_keys(&before.entries) {
        if !after.entries.contains_key(name) {
            diff.assign_removed(
                name.clone(),
                RemovedName {
                    before: Arc::clone(&before.entries[name]),
                },
            );
        }
    }
    diff
}
