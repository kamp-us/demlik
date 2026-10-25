use crate::{
    api::map::{ApiError, ApiInputError},
    project::{join_path_text, relative_path_text_from, resolve_path_text_from},
    text::JsString,
};
use std::{fs, path::Path};

pub fn package_root(root: &JsString) -> Result<JsString, ApiError> {
    let absolute =
        resolve_path_text_from(&JsString::default(), root).map_err(|source| ApiError::Io {
            path: root.clone(),
            source,
        })?;
    let path = absolute.to_lossy();
    if !Path::new(&path).exists()
        || !fs::metadata(&path)
            .map_err(|source| ApiError::Io {
                path: absolute.clone(),
                source,
            })?
            .is_dir()
    {
        let mut message = absolute;
        message.push_str(" is not a directory");
        return Err(ApiError::Input(ApiInputError::new(message)));
    }
    real_path(&absolute).map_err(|source| ApiError::Io {
        path: absolute,
        source,
    })
}
pub(crate) fn real_path(absolute: &JsString) -> Result<JsString, std::io::Error> {
    let canonical = fs::canonicalize(absolute.to_lossy())?;
    if String::from_utf16(absolute.units()).is_ok() {
        return Ok(canonical.to_string_lossy().as_ref().into());
    }
    // Node realpathSync keeps ordinary UTF16 components; only readlink's bytes
    // are decoded. canonicalize remains the native existence/cycle validator.
    fn components(path: &JsString) -> std::collections::VecDeque<JsString> {
        path.units()
            .split(|unit| *unit == 47)
            .filter(|part| !part.is_empty())
            .map(|part| JsString::from_units(part.to_vec()))
            .collect()
    }
    let mut pending = components(absolute);
    let mut resolved = JsString::from("/");
    while let Some(component) = pending.pop_front() {
        let candidate = join_path_text(&resolved, &component);
        if fs::symlink_metadata(candidate.to_lossy())?.is_symlink() {
            let target = fs::read_link(candidate.to_lossy())?;
            let target: JsString = target.to_string_lossy().as_ref().into();
            let expanded = resolve_path_text_from(&resolved, &target)?;
            let mut prefix = components(&expanded);
            prefix.append(&mut pending);
            pending = prefix;
            resolved = "/".into();
        } else {
            resolved = candidate;
        }
    }
    Ok(resolved)
}
pub fn project_relative(root: &JsString) -> Result<JsString, ApiError> {
    let cwd = std::env::current_dir().map_err(|source| ApiError::Io {
        path: root.clone(),
        source,
    })?;
    let relative = relative_path_text_from(&cwd.to_string_lossy().as_ref().into(), root).map_err(
        |source| ApiError::Io {
            path: root.clone(),
            source,
        },
    )?;
    Ok(if relative.is_empty() {
        ".".into()
    } else {
        relative
    })
}
