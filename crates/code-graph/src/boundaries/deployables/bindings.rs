use super::model::{BindingSite, DeployableFile, DeployableJudgmentError, Deployables, worker_of};
use crate::{
    boundaries::{
        rules::interpolate,
        violation::{BoundaryViolation, False},
    },
    data::extract::binding_sites,
    project::locale_compare_units,
    syntax::file::SyntaxFile,
    text::{JsString, object_keys},
};
use indexmap::{IndexMap, IndexSet};

pub fn binding_sites_of(
    deployables: &Deployables<'_>,
    file: &JsString,
    syntax: &SyntaxFile,
) -> Vec<BindingSite> {
    if deployables.kinds.is_empty() {
        return Vec::new();
    }
    let Some(bindings) = worker_of(deployables, file)
        .and_then(|worker| deployables.judged_for(worker))
        .filter(|bindings| !bindings.is_empty())
    else {
        return Vec::new();
    };
    binding_sites(syntax, bindings)
        .into_iter()
        .map(|site| BindingSite {
            binding: site.decl.binding.clone(),
            line: site.line as f64,
        })
        .collect()
}
pub fn binding_violations(
    file: &DeployableFile<'_>,
) -> Result<Vec<BoundaryViolation>, DeployableJudgmentError> {
    let mut used: Vec<_> = file
        .binding_sites
        .iter()
        .map(|site| &site.binding)
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    used.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
    let mut violations = Vec::new();
    for binding in used {
        let clean = if file.is_main {
            true
        } else if !file.driven {
            false
        } else {
            file.owners.permits(binding, file.file)?
        };
        if !clean {
            violations.push(BoundaryViolation::BindingOutsideDrivenAdapter {
                from: file.from.clone(),
                to: (),
                specifier: binding.clone(),
                type_only: False,
            });
        }
    }
    Ok(violations)
}
pub fn binding_owner_issue(
    scope: &JsString,
    owners: &IndexMap<JsString, Vec<JsString>>,
    files: &IndexSet<JsString>,
    deployables: &Deployables<'_>,
) -> Option<JsString> {
    for binding in object_keys(owners) {
        for owner in &owners[binding] {
            let named = interpolate(&[
                "owner \"".into(),
                owner.clone(),
                "\" of binding \"".into(),
                binding.clone(),
                "\" in \"".into(),
                scope.clone(),
                "\"".into(),
            ]);
            if !files.contains(owner) {
                return Some(interpolate(&[named," is no file the scope loads: an owner is an exact scope-relative .ts/.tsx path.".into()]));
            }
            let from = if scope == "." {
                owner.clone()
            } else {
                interpolate(&[scope.clone(), "/".into(), owner.clone()])
            };
            let Some(worker) = worker_of(deployables, &from) else {
                return Some(interpolate(&[
                    named,
                    " sits under no worker config, so no worker declares \"".into(),
                    binding.clone(),
                    "\".".into(),
                ]));
            };
            if !deployables
                .judged_for(worker)
                .is_some_and(|judged| judged.contains_key(binding))
            {
                return Some(interpolate(&[named,": the worker \"".into(),worker.service.clone(),"\" that owns it declares no service, D1, Durable Object, KV, R2 or queue binding \"".into(),binding.clone(),"\".".into()]));
            }
        }
    }
    None
}
