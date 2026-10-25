use super::{ImportTarget, Libraries, LibraryRuleError, import_target_of, owner_of};
use crate::{
    boundaries::rules::interpolate,
    syntax::{
        file::SyntaxFile,
        imports::{ImportedNames, imported_names_of},
    },
    text::{JsString, has_object_prototype_property, object_keys},
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
    let allowance = libraries
        .rules()
        .and_then(|rules| rules.allow_import_names.get(importer));
    let licensed = allowance.and_then(|allowance| allowance.get(dir));
    let inherited = licensed.is_none()
        && has_object_prototype_property(dir)
        && (allowance.is_some() || has_object_prototype_property(importer));
    if licensed.is_none() && !inherited {
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
            let Some(licensed) = licensed else {
                return Err(LibraryRuleError::InheritedLicense);
            };
            if !licensed.contains(name) {
                return Ok(false);
            }
        }
    }
    Ok(true)
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
