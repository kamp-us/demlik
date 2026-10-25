use super::policy::bump_policy;
use crate::{
    api::{
        map::{ApiError, ApiInputError},
        model::{
            ApiChange, ApiDiff, ApiRatchetMiss, ApiRatchetVerdict, Bump, BumpPolicy, BumpRule,
            ChangeKind, ChangesetsSince,
        },
    },
    text::{JsString, JsValue},
};
use std::sync::Arc;

pub fn api_changes(diff: &ApiDiff) -> Vec<ApiChange> {
    let mut subpaths = diff.subpaths.keys().collect::<Vec<_>>();
    subpaths.sort();
    let mut changes = Vec::new();
    for subpath in subpaths {
        let names = &diff.subpaths[subpath];
        let at = |name: &JsString, kind, before, after| ApiChange {
            subpath: subpath.clone(),
            tier: names.tier.clone(),
            name: name.clone(),
            kind,
            before,
            after,
        };
        let mut rows = names
            .added
            .iter()
            .map(|(name, value)| {
                at(
                    name,
                    ChangeKind::Added,
                    None,
                    Some(Arc::clone(&value.after)),
                )
            })
            .chain(names.changed.iter().map(|(name, value)| {
                at(
                    name,
                    ChangeKind::Changed,
                    Some(Arc::clone(&value.before)),
                    Some(Arc::clone(&value.after)),
                )
            }))
            .chain(names.removed.iter().map(|(name, value)| {
                at(
                    name,
                    ChangeKind::Removed,
                    Some(Arc::clone(&value.before)),
                    None,
                )
            }))
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.name.cmp(&right.name).then(left.kind.cmp(&right.kind)));
        changes.extend(rows);
    }
    changes
}
fn rule_for<'a>(policy: &'a BumpPolicy, change: &ApiChange) -> Result<&'a Arc<BumpRule>, ApiError> {
    let row = change
        .tier
        .as_ref()
        .and_then(|tier| policy.tiers.get(tier))
        .or(policy.default.as_ref());
    if let Some(row) = row {
        return Ok(match change.kind {
            ChangeKind::Added => &row.added,
            ChangeKind::Changed => &row.changed,
            ChangeKind::Removed => &row.removed,
        });
    }
    let mut message = JsString::from("bump policy: subpath ");
    message.extend(&change.subpath);
    message.push_str(" has ");
    match &change.tier {
        None => message.push_str("no tier"),
        Some(tier) => {
            message.push_str("tier \"");
            message.extend(tier);
            message.push_str("\"");
        }
    }
    message.push_str(", which the policy gives no row and no default");
    Err(ApiError::Input(ApiInputError::new(message)))
}
pub fn ratchet_api_diff(
    diff: &ApiDiff,
    policy: &JsValue,
    changesets: &ChangesetsSince,
) -> Result<ApiRatchetVerdict, ApiError> {
    let rules = bump_policy(policy)?;
    let highest_bump = changesets
        .changesets
        .iter()
        .map(|item| Bump::from(item.bump))
        .max()
        .unwrap_or(Bump::None);
    let callout_found = changesets.changesets.iter().any(|item| {
        item.body
            .units()
            .windows(rules.callout.units().len())
            .any(|part| part == rules.callout.units())
    });
    let mut misses = Vec::new();
    for change in api_changes(diff) {
        let needs = rule_for(&rules, &change)?;
        let met = needs.bump.rank() <= highest_bump.rank() && (!needs.callout || callout_found);
        if !met {
            misses.push(ApiRatchetMiss {
                change,
                needs: Arc::clone(needs),
            });
        }
    }
    let mut files = changesets
        .changesets
        .iter()
        .map(|item| item.file.clone())
        .collect::<Vec<_>>();
    files.sort();
    Ok(ApiRatchetVerdict {
        passed: misses.is_empty(),
        base: diff.base.clone(),
        package: changesets.package.clone(),
        changesets: files,
        highest_bump,
        callout_found,
        misses,
    })
}
