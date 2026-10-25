use super::Shape;
use crate::{
    boundaries::{
        impure::impure_modules_opened,
        libraries::{
            ImportTarget, Libraries, import_target_of, imported_from_outside, in_package_globs,
        },
        rules::{Place, ZoneName, in_scope},
        violation::BoundaryViolation,
    },
    syntax::imports::{ImportEdge, is_relative_units},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};

pub struct ApplicationFile<'a> {
    pub scope: &'a JsString,
    pub file: &'a JsString,
    pub feature: &'a JsString,
    pub own: &'a [ZoneName],
    pub import_edges: &'a [ImportEdge],
    pub runtime_specifiers: &'a IndexSet<JsString>,
    pub judged: &'a [&'a ImportEdge],
}
pub struct ApplicationWorld<'a> {
    pub rules: &'a Shape<'a>,
    pub libraries: &'a Libraries<'a>,
    pub place_of: &'a dyn Fn(&JsString) -> Place,
}
enum Outside<'a> {
    File(&'a str),
    PackageOrPath,
}
fn outside_file<'a>(
    file: &ApplicationFile<'_>,
    world: &ApplicationWorld<'_>,
    target: &'a str,
) -> Option<Outside<'a>> {
    match (world.place_of)(&target.into()) {
        Place::Lib => None,
        Place::Elsewhere => Some(Outside::File(target)),
        Place::Feature(place) => {
            if place.feature() != file.feature || file.own.contains(&place.zone_name()) {
                None
            } else {
                Some(Outside::File(target))
            }
        }
    }
}
fn outside_package(world: &ApplicationWorld<'_>, specifier: &JsString) -> Option<Outside<'static>> {
    if is_relative_units(specifier) || specifier.starts_with("/") {
        return Some(Outside::PackageOrPath);
    }
    let target = import_target_of(world.libraries, specifier);
    if let ImportTarget::Library { dir, .. } = target
        && imported_from_outside(world.libraries, &dir.into(), None)
    {
        return None;
    }
    let listed = matches!(target, ImportTarget::Library { type_name, .. } if world.rules.may_import.contains(type_name));
    if listed || in_package_globs(&world.rules.pure, specifier) {
        None
    } else {
        Some(Outside::PackageOrPath)
    }
}
fn outside_of<'a>(
    file: &ApplicationFile<'_>,
    world: &ApplicationWorld<'_>,
    edge: &'a ImportEdge,
) -> Option<Outside<'a>> {
    // Equal-valued copies are distinct members of source Set<ImportEdge>.
    if file.judged.iter().any(|held| std::ptr::eq(*held, edge))
        || !impure_modules_opened(std::slice::from_ref(edge), file.runtime_specifiers).is_empty()
    {
        return None;
    }
    match &edge.target {
        Some(target) => outside_file(file, world, target),
        None => outside_package(world, &edge.specifier),
    }
}
struct Reach<'a> {
    to: Option<JsString>,
    specifier: &'a JsString,
    type_only: bool,
}
pub fn application_violations(
    file: ApplicationFile<'_>,
    world: ApplicationWorld<'_>,
) -> Vec<BoundaryViolation> {
    let mut reached: IndexMap<JsString, Reach<'_>> = IndexMap::new();
    for edge in file.import_edges {
        let Some(outside) = outside_of(&file, &world, edge) else {
            continue;
        };
        let to = match outside {
            Outside::File(target) => Some(in_scope(file.scope, &target.into())),
            Outside::PackageOrPath => None,
        };
        let key = to.as_ref().unwrap_or(&edge.specifier).clone();
        let held = reached.entry(key).or_insert(Reach {
            to: None,
            specifier: &edge.specifier,
            type_only: true,
        });
        // A package spelling can equal a resolved file key: the latest edge owns `to`.
        held.to = to;
        held.type_only &= edge.type_only;
    }
    reached
        .into_values()
        .map(
            |reach| BoundaryViolation::ApplicationImportOutsideAllowlist {
                from: in_scope(file.scope, file.file),
                to: reach.to,
                specifier: reach.specifier.clone(),
                type_only: reach.type_only,
            },
        )
        .collect()
}
