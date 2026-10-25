use super::{impure::impure_rows, rules::*};
use crate::{
    kinds::glob::{GlobError, glob_to_regexp},
    text::{JsString, has_object_prototype_property, object_keys, object_prototype_function_name},
};
use indexmap::IndexSet;

#[derive(Debug)]
pub enum DeclarationError {
    TypeError(JsString),
    Pattern(GlobError),
}
impl DeclarationError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::TypeError(_) => "TypeError",
            Self::Pattern(_) => "SyntaxError",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::TypeError(message) => message.clone(),
            Self::Pattern(error) => error.to_string().into(),
        }
    }
}
impl std::fmt::Display for DeclarationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for DeclarationError {}
impl From<ZoningError> for DeclarationError {
    fn from(error: ZoningError) -> Self {
        Self::TypeError(error.to_string().into())
    }
}
type Result<T> = std::result::Result<T, DeclarationError>;

pub fn feature_declaration_issue(rules: &BoundaryRules) -> Option<JsString> {
    for scope in object_keys(&rules.features) {
        let features = &rules.features[scope];
        let mut seen = IndexSet::new();
        for feature in features {
            if seen.contains(feature) {
                return Some(interpolate(&[
                    "feature \"".into(),
                    feature.clone(),
                    "\" is declared twice in \"".into(),
                    scope.clone(),
                    "\".".into(),
                ]));
            }
            if rules.lib.contains(feature) {
                return Some(interpolate(&[
                    "\"".into(),
                    feature.clone(),
                    "\" in \"".into(),
                    scope.clone(),
                    "\" is declared as both a feature and lib.".into(),
                ]));
            }
            seen.insert(feature);
        }
        if let Some(issue) = layout_issue(scope, features) {
            return Some(issue);
        }
    }
    None
}
fn named_types(rules: &BoundaryRules) -> JsString {
    let declared = object_keys(&rules.library_types);
    let names = if declared.is_empty() {
        "none".into()
    } else {
        join(&declared, ", ")
    };
    interpolate(&["\"libraryTypes\" (declared: ".into(), names, ")".into()])
}
fn library_type_issues(rules: &BoundaryRules) -> Vec<JsString> {
    let mut out = Vec::new();
    let named = named_types(rules);
    for name in object_keys(&rules.library_types) {
        for imported in &rules.library_types[name].imports {
            if !rules.library_types.contains_key(imported) {
                out.push(interpolate(&[
                    "library type \"".into(),
                    name.clone(),
                    "\" imports \"".into(),
                    imported.clone(),
                    "\", which ".into(),
                    named.clone(),
                    " lacks.".into(),
                ]));
            }
        }
    }
    for directory in object_keys(&rules.libraries) {
        let name = &rules.libraries[directory];
        if !rules.library_types.contains_key(name) {
            out.push(interpolate(&[
                "library \"".into(),
                directory.clone(),
                "\" is type \"".into(),
                name.clone(),
                "\", which ".into(),
                named.clone(),
                " lacks.".into(),
            ]));
        }
    }
    out
}
fn world_library_issues(rules: &BoundaryRules) -> Result<Vec<JsString>> {
    let mut out = Vec::new();
    for entry in &rules.world_libraries {
        match glob_to_regexp(entry) {
            Ok(glob) => {
                if let Some(row) = impure_rows().find(|row| glob.test_str(row)) {
                    out.push(interpolate(&["world library \"".into(), entry.clone(), "\" matches the impure global \"".into(), row.into(), "\", which a pure library already may not use: a package and a global of one name would share one ledger entry, so declare a pattern that matches no global.".into()]));
                }
            }
            Err(GlobError::Syntax(message)) => out.push(interpolate(&[
                "world library \"".into(),
                entry.clone(),
                "\" is not a valid glob: ".into(),
                message,
                ".".into(),
            ])),
            Err(error) => return Err(DeclarationError::Pattern(error)),
        }
    }
    Ok(out)
}
fn inherited_value_key(name: &JsString) -> JsString {
    if name == "__proto__" {
        return "[object Object]".into();
    }
    let function = object_prototype_function_name(name).expect("a known prototype method");
    interpolate(&["function ".into(), function, "() { [native code] }".into()])
}
fn allowance_issues(rules: &BoundaryRules) -> Result<Vec<JsString>> {
    let mut out = Vec::new();
    for importer in object_keys(&rules.allow_import_names) {
        let importer_type = match rules.libraries.get(importer) {
            Some(name) => name.clone(),
            None if has_object_prototype_property(importer) => inherited_value_key(importer),
            None => {
                out.push(interpolate(&[
                    "allowImportNames importer \"".into(),
                    importer.clone(),
                    "\" is no declared library: add it to \"libraries\".".into(),
                ]));
                continue;
            }
        };
        for imported in object_keys(&rules.allow_import_names[importer]) {
            let imported_type = rules.libraries.get(imported);
            if imported_type.is_none() && !has_object_prototype_property(imported) {
                out.push(interpolate(&[
                    "allowImportNames \"".into(),
                    importer.clone(),
                    "\" licenses names of \"".into(),
                    imported.clone(),
                    "\", which is no declared library: add it to \"libraries\".".into(),
                ]));
                continue;
            }
            let redundant = match rules.library_types.get(&importer_type) {
                Some(kind) => imported_type.is_some_and(|name| kind.imports.contains(name)),
                None if has_object_prototype_property(&importer_type) => {
                    return Err(DeclarationError::TypeError(
                        "Cannot read properties of undefined (reading 'includes')".into(),
                    ));
                }
                None => false,
            };
            if redundant {
                out.push(interpolate(&[
                    "allowImportNames \"".into(),
                    importer.clone(),
                    "\" licenses names of \"".into(),
                    imported.clone(),
                    "\", but its type \"".into(),
                    importer_type.clone(),
                    "\" already lists \"".into(),
                    imported_type
                        .expect("a redundant type is an own string")
                        .clone(),
                    "\" in \"imports\": the allowance would enforce nothing.".into(),
                ]));
            }
        }
    }
    Ok(out)
}
pub fn library_declaration_issue(rules: &BoundaryRules) -> Result<Option<JsString>> {
    let mut issues = library_type_issues(rules);
    issues.extend(world_library_issues(rules)?);
    issues.extend(allowance_issues(rules)?);
    Ok(issues.into_iter().next())
}
pub fn deployable_declaration_issue(rules: &BoundaryRules) -> Result<Option<JsString>> {
    if rules.binding_owners.is_empty() {
        return Ok(None);
    }
    if !rules
        .across_deployables
        .contains(&DeployableKind::BindingOutsideDrivenAdapter)
    {
        return Ok(Some("\"bindingOwners\" narrows the bindings B17 judges, and \"acrossDeployables\" does not list \"binding-outside-driven-adapter\": with that kind off, an owner enforces nothing.".into()));
    }
    for scope in object_keys(&rules.binding_owners) {
        if !rules.features.contains_key(scope) && !has_object_prototype_property(scope) {
            return Ok(Some(interpolate(&[
                "\"bindingOwners\" declares scope \"".into(),
                scope.clone(),
                "\", which declares no \"features\": owners ride a scope that declares features."
                    .into(),
            ])));
        }
        let zoning = scope_zoning(rules, scope)?;
        for binding in object_keys(&rules.binding_owners[scope]) {
            for owner in &rules.binding_owners[scope][binding] {
                let touches_bindings = match feature_file_of(owner, &zoning) {
                    Some(FeatureFile::PerFeature { zone, .. }) => zone.rule.touches_bindings,
                    Some(FeatureFile::Port { zone, .. }) => zone.rule.touches_bindings,
                    None => false,
                };
                if !touches_bindings {
                    return Ok(Some(interpolate(&["owner \"".into(), owner.clone(), "\" of binding \"".into(), binding.clone(), "\" in \"".into(), scope.clone(), "\" is not under a driven adapter, ".into(), DRIVEN_HOMES.as_str().into(), ": only a driven adapter may use a binding, so an owner anywhere else could never be clean.".into()])));
                }
            }
        }
    }
    Ok(None)
}
fn shape_type_issues(
    rules: &BoundaryRules,
    key: &str,
    types: &[JsString],
    location: &JsString,
) -> Vec<JsString> {
    let named = named_types(rules);
    types
        .iter()
        .filter(|name| !rules.library_types.contains_key(*name))
        .map(|name| {
            interpolate(&[
                "\"".into(),
                key.into(),
                "\" names type \"".into(),
                name.clone(),
                "\"".into(),
                location.clone(),
                ", which ".into(),
                named.clone(),
                " lacks.".into(),
            ])
        })
        .collect()
}
fn glob_issues(key: &str, globs: &[JsString]) -> Result<Vec<JsString>> {
    let mut issues = Vec::new();
    for glob in globs {
        match glob_to_regexp(glob) {
            Ok(_) => {}
            Err(GlobError::Syntax(message)) => issues.push(interpolate(&[
                "\"".into(),
                key.into(),
                "\" entry \"".into(),
                glob.clone(),
                "\" is not a valid glob: ".into(),
                message,
                ".".into(),
            ])),
            Err(error) => return Err(DeclarationError::Pattern(error)),
        }
    }
    Ok(issues)
}
fn is_driven(file: &JsString, zoning: &ScopeZoning) -> bool {
    match feature_file_of(file, zoning) {
        Some(FeatureFile::PerFeature { zone, .. }) => zone.name == ZoneName::Driven,
        Some(FeatureFile::Port { zone, .. }) => zone.name == PortZoneName::Driven,
        None => false,
    }
}
pub fn shape_declaration_issue(rules: &BoundaryRules) -> Result<Option<JsString>> {
    let mut issues = Vec::new();
    if !rules
        .application_shape
        .contains(&ShapeKind::ApplicationImportOutsideAllowlist)
    {
        for (key, list) in [
            ("applicationMayImport", &rules.application_may_import),
            ("pureDependencies", &rules.pure_dependencies),
        ] {
            if !list.is_empty() {
                issues.push(interpolate(&["\"".into(), key.into(), "\" says what B16 allows, and \"applicationShape\" does not list \"application-import-outside-allowlist\": with that kind off, the key enforces nothing.".into()]));
            }
        }
    }
    issues.extend(shape_type_issues(
        rules,
        "applicationMayImport",
        &rules.application_may_import,
        &JsString::default(),
    ));
    issues.extend(glob_issues("pureDependencies", &rules.pure_dependencies)?);
    issues.extend(glob_issues("testFiles", &rules.test_files)?);
    issues.extend(glob_issues("compositionRoots", &rules.composition_roots)?);
    if !rules.composition_roots.is_empty() && rules.test_files.is_empty() {
        issues.push("\"compositionRoots\" says what a test may not reach, and \"testFiles\" lists no glob: with no file a test, the key enforces nothing.".into());
    }
    for scope in object_keys(&rules.read_allowance) {
        if !rules.features.contains_key(scope) && !has_object_prototype_property(scope) {
            issues.push(interpolate(&[
                "\"readAllowance\" declares scope \"".into(),
                scope.clone(),
                "\", which declares no \"features\": it rides a scope that declares features."
                    .into(),
            ]));
        }
    }
    for scope in object_keys(&rules.read_allowance) {
        let allowance = &rules.read_allowance[scope];
        let zoning = scope_zoning(rules, scope)?;
        for (key, empty) in [
            ("driven", allowance.driven.is_empty()),
            (
                "decidedBy",
                allowance.decided_by.as_ref().is_some_and(Vec::is_empty),
            ),
        ] {
            if empty {
                issues.push(interpolate(&[
                    "\"readAllowance\" in \"".into(),
                    scope.clone(),
                    "\" lists no \"".into(),
                    key.into(),
                    "\" entry: an allowance that grants nothing.".into(),
                ]));
            }
        }
        for file in &allowance.driven {
            if !is_driven(file, &zoning) {
                issues.push(interpolate(&["file \"".into(), file.clone(), "\" of \"readAllowance\" in \"".into(), scope.clone(), "\" is not under a driven adapter, ".into(), DRIVEN_HOMES.as_str().into(), ": only a driven file can be read through, so a listing anywhere else could never grant.".into()]));
            }
        }
        let location = interpolate(&[" in \"".into(), scope.clone(), "\"".into()]);
        issues.extend(shape_type_issues(
            rules,
            "readAllowance",
            allowance.decided_by.as_deref().unwrap_or_default(),
            &location,
        ));
    }
    Ok(issues.into_iter().next())
}
pub fn declaration_issue(rules: &BoundaryRules) -> Result<Option<JsString>> {
    if let Some(issue) = feature_declaration_issue(rules) {
        return Ok(Some(issue));
    }
    if let Some(issue) = library_declaration_issue(rules)? {
        return Ok(Some(issue));
    }
    if let Some(issue) = deployable_declaration_issue(rules)? {
        return Ok(Some(issue));
    }
    shape_declaration_issue(rules)
}
