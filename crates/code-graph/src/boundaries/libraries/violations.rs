use super::{
    ImportTarget, Libraries, LibraryRuleError,
    allowance::{NamedFile, is_licensed},
    import_target_of, imported_from_outside, is_world_library, library_type_of, owner_of,
    undeclared_under,
};
use crate::{
    boundaries::{
        impure_uses::{ImpureFacts, impure_names_of},
        rules::ImportedFrom,
        violation::{BoundaryViolation, False},
    },
    syntax::imports::ImportedNames,
    text::{JsString, has_object_prototype_property},
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

pub struct LibraryFile<'a> {
    pub file: &'a JsString,
    pub imported_names: &'a IndexMap<JsString, ImportedNames>,
    pub facts: ImpureFacts<'a>,
}
#[derive(Debug, Default, Serialize)]
pub struct LibraryJudgment {
    pub violations: Vec<BoundaryViolation>,
    pub unjudged: usize,
}
struct Reach<'a> {
    dir: &'a str,
    type_name: &'a JsString,
    specifier: &'a JsString,
    specifiers: IndexSet<JsString>,
    type_only: bool,
}
pub fn judge_libraries(
    libraries: &Libraries<'_>,
    scope: &JsString,
    file: LibraryFile<'_>,
    zone: Option<ImportedFrom>,
) -> Result<LibraryJudgment, LibraryRuleError> {
    let importer = owner_of(libraries, file.file);
    if importer.is_some_and(|importer| scope != importer) {
        return Ok(LibraryJudgment::default());
    }
    let mut found: IndexMap<&str, Reach<'_>> = IndexMap::new();
    let mut undeclared = IndexSet::new();
    for edge in file.facts.import_edges {
        match import_target_of(libraries, &edge.specifier) {
            ImportTarget::Undeclared { dir } => {
                undeclared.insert(dir);
            }
            ImportTarget::Library { dir, type_name } if Some(dir) != importer => {
                let held = found.entry(dir).or_insert_with(|| Reach {
                    dir,
                    type_name,
                    specifier: &edge.specifier,
                    specifiers: IndexSet::new(),
                    type_only: true,
                });
                held.specifiers.insert(edge.specifier.clone());
                held.type_only &= edge.type_only;
            }
            _ => {}
        }
    }
    let mut violations = Vec::new();
    for reach in found.values() {
        let barred = if let Some(importer) = importer {
            let importer_text = JsString::from(importer);
            match library_type_of(libraries, &importer_text) {
                Some(kind) if !kind.imports.contains(reach.type_name) => !is_licensed(
                    libraries,
                    &importer_text,
                    &reach.dir.into(),
                    &reach.specifiers,
                    NamedFile {
                        file: file.file,
                        imported_names: file.imported_names,
                    },
                )?,
                None if libraries
                    .type_of_dir
                    .get(importer)
                    .is_some_and(|name| has_object_prototype_property(name)) =>
                {
                    return Err(LibraryRuleError::InheritedType);
                }
                _ => false,
            }
        } else {
            false
        };
        if barred {
            violations.push(BoundaryViolation::LibraryImportsUp {
                from: file.file.clone(),
                to: reach.dir.into(),
                specifier: reach.specifier.clone(),
                type_only: reach.type_only,
            });
        } else if imported_from_outside(libraries, &reach.dir.into(), zone) {
            violations.push(BoundaryViolation::AdapterLibraryImportedOutsideDriven {
                from: file.file.clone(),
                to: reach.dir.into(),
                specifier: reach.specifier.clone(),
                type_only: reach.type_only,
            });
        }
    }
    if importer.is_some_and(|importer| {
        library_type_of(libraries, &importer.into()).is_some_and(|kind| kind.pure)
    }) {
        violations.extend(
            impure_names_of(ImpureFacts {
                impure_uses: file.facts.impure_uses,
                import_edges: file.facts.import_edges,
                runtime_specifiers: file.facts.runtime_specifiers,
            })
            .into_iter()
            .map(|specifier| BoundaryViolation::Impure {
                from: file.file.clone(),
                to: (),
                specifier,
                type_only: false,
            }),
        );
        let mut world: IndexMap<&JsString, bool> = IndexMap::new();
        for edge in file.facts.import_edges {
            if is_world_library(libraries, &edge.specifier) {
                *world.entry(&edge.specifier).or_insert(true) &= edge.type_only;
            }
        }
        violations.extend(world.into_iter().map(|(specifier, type_only)| {
            BoundaryViolation::Impure {
                from: file.file.clone(),
                to: (),
                specifier: specifier.clone(),
                type_only,
            }
        }));
    }
    Ok(LibraryJudgment {
        violations,
        unjudged: if importer.is_some() {
            undeclared.len()
        } else {
            0
        },
    })
}
pub fn undeclared_libraries(libraries: &Libraries<'_>, root: &JsString) -> Vec<BoundaryViolation> {
    undeclared_under(libraries, root)
        .into_iter()
        .map(|dir| {
            let dir = JsString::from(dir);
            let specifier = if root == "." {
                dir.clone()
            } else {
                JsString::from_units(dir.units()[root.units().len() + 1..].to_vec())
            };
            BoundaryViolation::LibraryUndeclared {
                from: dir,
                to: (),
                specifier,
                type_only: False,
            }
        })
        .collect()
}
