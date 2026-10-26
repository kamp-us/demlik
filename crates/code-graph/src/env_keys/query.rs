use super::{
    EnvKeyError, EnvKeyFinding, EnvKeyReport, UndeclaredEnvRead, WithheldEnvKey,
    WithheldEnvKeyReason,
    extract::{EnvKeyScan, EnvReadVia, scan_env_keys},
    read_site_owner::{ReadSiteOwner, read_site_owner},
};
use crate::{
    extract::wrangler_config::{BindingCatalog, load_binding_catalog},
    project::{join_path_text, load_cheap_project, locale_compare_units},
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
fn by_key_reason(a: &WithheldEnvKey, b: &WithheldEnvKey) -> std::cmp::Ordering {
    locale_compare_units(a.key.units(), b.key.units())
        .then_with(|| a.reason.as_str().cmp(b.reason.as_str()))
}
fn find_env_key_mismatches(catalog: BindingCatalog, scan: EnvKeyScan) -> EnvKeyReport {
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
        keys.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
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
    declared_unreferenced.sort_by(|a, b| {
        locale_compare_units(a.service.units(), b.service.units())
            .then_with(|| locale_compare_units(a.key.units(), b.key.units()))
    });
    declared_withheld.sort_by(|a, b| locale_compare_units(a.key.units(), b.key.units()));
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
    read_not_declared.sort_by(|a, b| {
        locale_compare_units(a.key.units(), b.key.units())
            .then_with(|| locale_compare_units(a.file.units(), b.file.units()))
            .then_with(|| {
                a.line
                    .partial_cmp(&b.line)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    read_withheld.sort_by(by_key_reason);
    declared_withheld.extend(read_withheld);
    declared_withheld.sort_by(by_key_reason);
    EnvKeyReport {
        declared_unreferenced,
        read_not_declared,
        withheld: declared_withheld,
        declared_count: declared_count as f64,
        read_count: scan.reads.len() as f64,
        unparsed_configs: catalog.unparsed_configs,
    }
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
pub(crate) fn load_env_key_report(
    root: &JsString,
    repo: &JsString,
) -> Result<EnvKeyReport, EnvKeyError> {
    let source =
        load_cheap_project(Path::new(&root.to_lossy()), None).map_err(EnvKeyError::Project)?;
    let catalog =
        load_binding_catalog(Path::new(&repo.to_lossy()), None).map_err(EnvKeyError::Catalog)?;
    let candidates = catalog
        .manifests
        .iter()
        .flat_map(|m| m.env_keys.iter().chain(&m.dev_vars_keys))
        .cloned()
        .collect();
    let mut scan = scan_env_keys(&source.source_files, &candidates);
    for read in &mut scan.reads {
        read.file = to_repo_relative(repo, join_path_text(root, &read.file));
    }
    Ok(find_env_key_mismatches(catalog, scan))
}
