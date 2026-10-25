use crate::{
    api::map::{ApiError, ApiInputError},
    project::{relative_path_text_from, resolve_path_text_from},
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
    fs::canonicalize(path)
        .map(|root| root.to_string_lossy().as_ref().into())
        .map_err(|source| ApiError::Io {
            path: absolute,
            source,
        })
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
