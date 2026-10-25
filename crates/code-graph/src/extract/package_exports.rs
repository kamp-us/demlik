use crate::kinds::rules::JsRegex;
use crate::project::{join_path_text, locale_compare_units, relative_path_text};
use crate::text::{JsObject, JsString, JsValue, object_keys, serialize_object};
use serde::{Serialize, Serializer};
use std::{fs, io, path::Path};

pub struct Manifest {
    own: JsObject,
    prototype: Option<JsValue>,
}
impl Manifest {
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.own
            .get(&JsString::from(key))
            .or_else(|| self.prototype.as_ref()?.get(key))
    }
}
impl Serialize for Manifest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize_object(&self.own, serializer)
    }
}
pub fn read_manifest(repo_root: &Path, dir: &str) -> Option<Manifest> {
    let directory = join_path_text(&repo_root.to_string_lossy().as_ref().into(), &dir.into());
    let path = join_path_text(&directory, &"package.json".into());
    let bytes = fs::read(path.to_lossy()).ok()?;
    let JsValue::Object(mut own) = JsValue::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
        return None;
    };
    // readManifest copies only the root JSON.parse entries into an ordinary object.
    let prototype = own.shift_remove(&JsString::from("__proto__"));
    Some(Manifest { own, prototype })
}
pub fn package_name(manifest: &Manifest) -> Option<&JsString> {
    manifest
        .get("name")
        .and_then(JsValue::as_string)
        .filter(|name| !name.is_empty())
}
fn string_leaves(value: &JsValue, into: &mut Vec<JsString>) {
    match value {
        JsValue::String(value) => into.push(value.clone()),
        JsValue::Array(values) => {
            for value in values {
                string_leaves(value, into);
            }
        }
        JsValue::Object(object) => {
            for key in object_keys(object) {
                string_leaves(&object[key], into);
            }
        }
        _ => {}
    }
}
fn declared_targets(manifest: &Manifest) -> Vec<JsString> {
    let mut out = Vec::new();
    for key in ["main", "module", "types", "browser", "bin", "exports"] {
        if let Some(value) = manifest.get(key) {
            string_leaves(value, &mut out);
        }
    }
    out
}
fn strip_suffix<'a>(value: &'a [u16], suffix: &str) -> Option<&'a [u16]> {
    value.strip_suffix(suffix.encode_utf16().collect::<Vec<_>>().as_slice())
}
fn source_path(target: &JsString) -> JsString {
    let mut rel = target
        .units()
        .strip_prefix(&[u16::from(b'.'), u16::from(b'/')])
        .unwrap_or(target.units())
        .to_vec();
    let dist: Vec<_> = "dist/".encode_utf16().collect();
    if rel.starts_with(&dist) {
        rel = "src/"
            .encode_utf16()
            .chain(rel[dist.len()..].iter().copied())
            .collect();
    }
    for suffix in [".d.ts", ".js", ".mjs", ".cjs"] {
        if let Some(prefix) = strip_suffix(&rel, suffix) {
            return JsString::from_units(
                prefix.iter().copied().chain(".ts".encode_utf16()).collect(),
            );
        }
    }
    JsString::from_units(rel)
}
fn typescript_path(path: &JsString) -> bool {
    strip_suffix(path.units(), ".ts").is_some() || strip_suffix(path.units(), ".tsx").is_some()
}
pub fn package_source_entry(repo_root: &Path, dir: &str) -> Option<JsString> {
    let manifest = read_manifest(repo_root, dir)?;
    let mut candidates: Vec<_> = declared_targets(&manifest)
        .iter()
        .map(source_path)
        .filter(|path| typescript_path(path) && !path.units().contains(&u16::from(b'*')))
        .collect();
    candidates.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    let base = join_path_text(&repo_root.to_string_lossy().as_ref().into(), &dir.into());
    for candidate in candidates {
        if Path::new(&join_path_text(&base, &candidate).to_lossy()).exists() {
            let mut entry = JsString::from(dir);
            entry.push_str("/");
            entry.extend(&candidate);
            return Some(entry);
        }
    }
    None
}
#[derive(Debug)]
pub enum ExportPatternError {
    WorkingDirectory(io::Error),
    Pattern(regress::Error),
}
impl std::fmt::Display for ExportPatternError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkingDirectory(error) => error.fmt(f),
            Self::Pattern(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for ExportPatternError {}
fn to_pattern(source: &JsString) -> Result<Option<JsRegex>, regress::Error> {
    let Some(without_ext) =
        strip_suffix(source.units(), ".ts").or_else(|| strip_suffix(source.units(), ".tsx"))
    else {
        return Ok(None);
    };
    let metacharacters: Vec<_> = ".+?^${}()|[]\\".encode_utf16().collect();
    let mut units = vec![u16::from(b'^')];
    for unit in without_ext {
        if *unit == u16::from(b'*') {
            units.extend("[^\\n]*".encode_utf16());
        } else {
            if metacharacters.contains(unit) {
                units.push(u16::from(b'\\'));
            }
            units.push(*unit);
        }
    }
    units.extend("\\.(ts|tsx)$".encode_utf16());
    JsRegex::new(&JsString::from_units(units)).map(Some)
}
pub fn public_export_patterns(
    repo_root: &Path,
    root: &Path,
    package_dirs: &[String],
) -> Result<Vec<JsRegex>, ExportPatternError> {
    let mut patterns = Vec::new();
    for dir in package_dirs {
        let Some(manifest) = read_manifest(repo_root, dir) else {
            continue;
        };
        let package_absolute = join_path_text(
            &repo_root.to_string_lossy().as_ref().into(),
            &dir.as_str().into(),
        );
        for target in declared_targets(&manifest) {
            let absolute = join_path_text(&package_absolute, &source_path(&target));
            let relative = relative_path_text(root, &absolute)
                .map_err(ExportPatternError::WorkingDirectory)?;
            if relative.starts_with("../") {
                continue;
            }
            if let Some(pattern) = to_pattern(&relative).map_err(ExportPatternError::Pattern)? {
                patterns.push(pattern);
            }
        }
    }
    Ok(patterns)
}
