use super::{
    EnvKeyError, EnvKeyFinding, EnvKeyReport, UndeclaredEnvRead, WithheldEnvKey,
    WithheldEnvKeyReason,
    extract::{EnvKeyScan, EnvReadVia, scan_env_keys},
    read_site_owner::{ReadSiteOwner, read_site_owner},
};
use crate::{
    extract::wrangler_config::{BindingCatalog, load_binding_catalog_request},
    project::{Collation, CollationError, CollationInput, join_path_text, load_cheap_project},
    text::JsString,
};
use indexmap::IndexSet;
use std::path::Path;
fn dedupe_key(first: &JsString, second: &JsString) -> JsString {
    let mut key = first.clone();
    key.push_str("\t");
    key.extend(second);
    key
}
fn sort_key_reason<'c>(
    rows: Vec<WithheldEnvKey>,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<Vec<WithheldEnvKey>, CollationError> {
    if rows.len() < 2 {
        return Ok(rows);
    }
    let collation = request()?;
    let mut keyed = rows
        .into_iter()
        .map(|row| CollationInput::from_utf16(row.key.units()).map(|key| (row, key)))
        .collect::<Result<Vec<_>, _>>()?;
    keyed.sort_by(|(a, ak), (b, bk)| {
        collation
            .compare(ak, bk)
            .then_with(|| a.reason.as_str().cmp(b.reason.as_str()))
    });
    Ok(keyed.into_iter().map(|(row, _)| row).collect())
}
fn find_env_key_mismatches<'c>(
    catalog: BindingCatalog,
    scan: EnvKeyScan,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<EnvKeyReport, CollationError> {
    let read_names: IndexSet<_> = scan.reads.iter().map(|r| &r.name).collect();
    let mut declared_unreferenced = Vec::new();
    let mut declared_withheld = Vec::new();
    let mut declared_count = 0usize;
    let mut seen = IndexSet::new();
    let mut known = IndexSet::new();
    for manifest in &catalog.manifests {
        let mut keys: Vec<_> = manifest
            .env_keys
            .iter()
            .chain(&manifest.dev_vars_keys)
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        if keys.len() > 1 {
            let collation = request()?;
            let mut keyed = keys
                .into_iter()
                .map(|key| CollationInput::from_utf16(key.units()).map(|input| (key, input)))
                .collect::<Result<Vec<_>, _>>()?;
            keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));
            keys = keyed.into_iter().map(|(key, _)| key).collect();
        }
        known.extend(
            manifest
                .env_keys
                .iter()
                .chain(&manifest.dev_vars_keys)
                .chain(&manifest.binding_names),
        );
        for key in keys {
            if !seen.insert(dedupe_key(&manifest.service, key)) {
                continue;
            }
            declared_count += 1;
            if read_names.contains(key) {
                continue;
            }
            if scan
                .occurs_in
                .get(key)
                .is_some_and(|files| !files.is_empty())
            {
                declared_withheld.push(WithheldEnvKey {
                    key: key.clone(),
                    reason: WithheldEnvKeyReason::OccursElsewhereInSource,
                });
                continue;
            }
            declared_unreferenced.push(EnvKeyFinding {
                key: key.clone(),
                service: manifest.service.clone(),
                config_file: manifest.config_file.clone(),
            });
        }
    }
    if declared_unreferenced.len() > 1 {
        let collation = request()?;
        let mut keyed = declared_unreferenced
            .into_iter()
            .map(|row| {
                let service = CollationInput::from_utf16(row.service.units())?;
                let key = CollationInput::from_utf16(row.key.units())?;
                Ok((row, service, key))
            })
            .collect::<Result<Vec<_>, CollationError>>()?;
        keyed.sort_by(|(_, a, ak), (_, b, bk)| {
            collation
                .compare(a, b)
                .then_with(|| collation.compare(ak, bk))
        });
        declared_unreferenced = keyed.into_iter().map(|(row, _, _)| row).collect();
    }
    if declared_withheld.len() > 1 {
        let collation = request()?;
        let mut keyed = declared_withheld
            .into_iter()
            .map(|row| CollationInput::from_utf16(row.key.units()).map(|key| (row, key)))
            .collect::<Result<Vec<_>, _>>()?;
        keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));
        declared_withheld = keyed.into_iter().map(|(row, _)| row).collect();
    }
    let mut read_not_declared = Vec::new();
    let mut read_withheld = Vec::new();
    let mut seen_withheld = IndexSet::new();
    for read in &scan.reads {
        if read.via != EnvReadVia::Env || known.contains(&read.name) {
            continue;
        }
        let reason = match read_site_owner(&catalog, &read.file) {
            ReadSiteOwner::Worker { service } => {
                read_not_declared.push(UndeclaredEnvRead {
                    key: read.name.clone(),
                    file: read.file.clone(),
                    line: read.line as f64,
                    service: service.clone(),
                });
                continue;
            }
            ReadSiteOwner::None => WithheldEnvKeyReason::ReadSiteOwnerUnknown,
            ReadSiteOwner::UnparsedConfig => WithheldEnvKeyReason::ReadSiteOwnerUnparsed,
        };
        if seen_withheld.insert(dedupe_key(&reason.as_str().into(), &read.name)) {
            read_withheld.push(WithheldEnvKey {
                key: read.name.clone(),
                reason,
            });
        }
    }
    if read_not_declared.len() > 1 {
        let collation = request()?;
        let mut keyed = read_not_declared
            .into_iter()
            .map(|row| {
                let key = CollationInput::from_utf16(row.key.units())?;
                let file = CollationInput::from_utf16(row.file.units())?;
                Ok((row, key, file))
            })
            .collect::<Result<Vec<_>, CollationError>>()?;
        keyed.sort_by(|(a, ak, af), (b, bk, bf)| {
            collation
                .compare(ak, bk)
                .then_with(|| collation.compare(af, bf))
                .then_with(|| {
                    a.line
                        .partial_cmp(&b.line)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });
        read_not_declared = keyed.into_iter().map(|(row, _, _)| row).collect();
    }
    declared_withheld.extend(sort_key_reason(read_withheld, request)?);
    declared_withheld = sort_key_reason(declared_withheld, request)?;
    Ok(EnvKeyReport {
        declared_unreferenced,
        read_not_declared,
        withheld: declared_withheld,
        declared_count: declared_count as f64,
        read_count: scan.reads.len() as f64,
        unparsed_configs: catalog.unparsed_configs,
    })
}
fn to_repo_relative(repo: &JsString, absolute: JsString) -> JsString {
    let mut prefix = repo.clone();
    prefix.push_str("/");
    if absolute.units().starts_with(prefix.units()) {
        JsString::from_units(absolute.units()[prefix.units().len()..].to_vec())
    } else {
        absolute
    }
}
pub(crate) fn load_env_key_report<'c>(
    root: &JsString,
    repo: &JsString,
    request: impl FnOnce() -> Result<&'c Collation, CollationError>,
) -> Result<EnvKeyReport, EnvKeyError> {
    let mut retained = None;
    let mut request = Some(request);
    let mut request = || {
        if let Some(collation) = retained {
            return Ok(collation);
        }
        let collation = request
            .take()
            .expect("env keys request the same borrowed handle once")()?;
        retained = Some(collation);
        Ok(collation)
    };
    let source =
        load_cheap_project(Path::new(&root.to_lossy()), None).map_err(EnvKeyError::Project)?;
    let catalog = load_binding_catalog_request(Path::new(&repo.to_lossy()), None, &mut request)
        .map_err(EnvKeyError::Catalog)?;
    let candidates = catalog
        .manifests
        .iter()
        .flat_map(|m| m.env_keys.iter().chain(&m.dev_vars_keys))
        .cloned()
        .collect();
    let mut scan = scan_env_keys(&source.source_files, &candidates, &mut request)
        .map_err(EnvKeyError::Collation)?;
    for read in &mut scan.reads {
        read.file = to_repo_relative(repo, join_path_text(root, &read.file));
    }
    find_env_key_mismatches(catalog, scan, &mut request).map_err(EnvKeyError::Collation)
}

#[cfg(test)]
#[path = "icu77_probe.rs"]
mod icu77_probe;
