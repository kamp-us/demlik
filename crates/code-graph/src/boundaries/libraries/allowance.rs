use super::{ImportTarget, Libraries, LibraryRuleError, import_target_of, owner_of};
use crate::{
    boundaries::rules::interpolate,
    syntax::{
        file::SyntaxFile,
        imports::{ImportedNames, imported_names_of},
    },
    text::{JsString, has_object_prototype_property, object_keys, object_prototype_function_name},
};
use indexmap::{IndexMap, IndexSet};

pub struct NamedFile<'a> {
    pub file: &'a JsString,
    pub imported_names: &'a IndexMap<JsString, ImportedNames>,
}
pub fn imported_names_for(
    libraries: &Libraries<'_>,
    scope: &JsString,
    syntax: &SyntaxFile,
) -> IndexMap<JsString, ImportedNames> {
    if libraries
        .rules()
        .is_some_and(|rules| rules.allow_import_names.contains_key(scope))
        || has_object_prototype_property(scope)
    {
        imported_names_of(syntax)
    } else {
        IndexMap::new()
    }
}
pub fn is_licensed(
    libraries: &Libraries<'_>,
    importer: &JsString,
    dir: &JsString,
    specifiers: &IndexSet<JsString>,
    file: NamedFile<'_>,
) -> Result<bool, LibraryRuleError> {
    let licensed = licensed_names(libraries, importer, dir)?;
    if matches!(licensed, LicensedNames::Absent) {
        return Ok(false);
    }
    for specifier in specifiers {
        let Some(imported) = file.imported_names.get(specifier) else {
            return Ok(false);
        };
        if imported.unreadable {
            return Ok(false);
        }
        for name in &imported.names {
            let includes = match &licensed {
                LicensedNames::Names(names) => names.contains(name),
                LicensedNames::FunctionName(text) => {
                    name.is_empty()
                        || text
                            .units()
                            .windows(name.units().len())
                            .any(|part| part == name.units())
                }
                LicensedNames::Null => return Err(LibraryRuleError::NullLicense),
                LicensedNames::Other => return Err(LibraryRuleError::InheritedLicense),
                LicensedNames::Absent => {
                    unreachable!("an absent license returned before the names were read")
                }
            };
            if !includes {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

enum LicensedNames<'a> {
    Names(&'a [JsString]),
    FunctionName(JsString),
    Other,
    Null,
    Absent,
}
fn licensed_names<'a>(
    libraries: &'a Libraries<'_>,
    importer: &JsString,
    dir: &JsString,
) -> Result<LicensedNames<'a>, LibraryRuleError> {
    if let Some(allowance) = libraries
        .rules()
        .and_then(|rules| rules.allow_import_names.get(importer))
    {
        return Ok(allowance.get(dir).map_or_else(
            || {
                if has_object_prototype_property(dir) {
                    LicensedNames::Other
                } else {
                    LicensedNames::Absent
                }
            },
            |names| LicensedNames::Names(names),
        ));
    }
    if importer == "__proto__" {
        return Ok(if dir == "__proto__" {
            LicensedNames::Null
        } else if has_object_prototype_property(dir) {
            LicensedNames::Other
        } else {
            LicensedNames::Absent
        });
    }
    let Some(name) = object_prototype_function_name(importer) else {
        return Ok(LicensedNames::Absent);
    };
    Ok(if dir == "name" {
        LicensedNames::FunctionName(name)
    } else if dir == "caller" || dir == "arguments" {
        return Err(LibraryRuleError::RestrictedFunctionProperty);
    } else if dir == "length"
        || (dir == "prototype" && importer == "constructor")
        || dir == "apply"
        || dir == "bind"
        || dir == "call"
        || has_object_prototype_property(dir)
    {
        LicensedNames::Other
    } else {
        LicensedNames::Absent
    })
}
pub fn allowance_issue(
    libraries: &Libraries<'_>,
    scope: &JsString,
    files: &[NamedFile<'_>],
) -> Option<JsString> {
    let allowance = libraries.rules()?.allow_import_names.get(scope)?;
    let mut taken: IndexMap<String, IndexSet<JsString>> = IndexMap::new();
    for file in files {
        let path = interpolate(&[scope.clone(), "/".into(), file.file.clone()]);
        if !owner_of(libraries, &path).is_some_and(|owner| scope == owner) {
            continue;
        }
        for (specifier, imported) in file.imported_names {
            let ImportTarget::Library { dir, .. } = import_target_of(libraries, specifier) else {
                continue;
            };
            if scope == dir {
                continue;
            }
            taken
                .entry(dir.into())
                .or_default()
                .extend(imported.names.iter().cloned());
        }
    }
    for dir in object_keys(allowance) {
        let taken = dir.to_utf8().ok().and_then(|dir| taken.get(&dir));
        if let Some(never) = allowance[dir]
            .iter()
            .find(|name| taken.is_none_or(|taken| !taken.contains(*name)))
        {
            return Some(interpolate(&[
                "allowImportNames \"".into(),
                scope.clone(),
                "\" licenses \"".into(),
                never.clone(),
                "\" of \"".into(),
                dir.clone(),
                "\", which \"".into(),
                scope.clone(),
                "\" never imports from it: remove the name.".into(),
            ]));
        }
    }
    None
}
