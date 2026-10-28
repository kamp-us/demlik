use super::{
    bindings::binding_violations,
    model::{DeployableFile, DeployableJudgmentError, Deployables},
    workspaces::cross_workspace_imports,
};
use crate::{
    boundaries::{rules::DeployableKind, violation::BoundaryViolation},
    project::Collation,
};

pub fn judge_deployables(
    deployables: &Deployables<'_>,
    file: &DeployableFile<'_>,
    collation: &Collation,
) -> Result<Vec<BoundaryViolation>, DeployableJudgmentError> {
    let mut violations = Vec::new();
    for kind in &deployables.kinds {
        match kind {
            DeployableKind::BindingOutsideDrivenAdapter => {
                violations.extend(binding_violations(file, collation)?)
            }
            DeployableKind::WorkerCallCycle => {}
            DeployableKind::RelativeImportCrossesWorkspace => {
                violations.extend(cross_workspace_imports(
                    &deployables.workspaces,
                    file.scope,
                    file.from,
                    file.import_edges,
                ))
            }
        }
    }
    Ok(violations)
}
