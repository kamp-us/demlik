use super::ceilings::{CeilingInputError, CommentCeilings};
use crate::{
    config::{ConfigFile, invalid_config, read_config},
    text::JsString,
    validation::RecordTypeError,
};
use std::path::Path;

#[derive(Debug)]
pub enum CommentConfigResolution {
    Resolved(CommentCeilings),
    Refused { message: JsString },
}
pub fn resolve_comment_ceilings(
    file: Option<&Path>,
) -> Result<CommentConfigResolution, RecordTypeError> {
    resolve(file.map(ConfigFile::Native))
}
pub(crate) fn resolve_comment_ceilings_text(
    file: Option<&JsString>,
) -> Result<CommentConfigResolution, RecordTypeError> {
    resolve(file.map(ConfigFile::Text))
}
fn resolve(file: Option<ConfigFile<'_>>) -> Result<CommentConfigResolution, RecordTypeError> {
    let Some(file) = file else {
        return Ok(CommentConfigResolution::Resolved(CommentCeilings::default()));
    };
    let label = match &file {
        ConfigFile::Native(path) => JsString::from(path.to_string_lossy().as_ref()),
        ConfigFile::Text(text) => (*text).clone(),
    };
    let value = match read_config(file) {
        Ok(value) => value,
        Err(message) => return Ok(CommentConfigResolution::Refused { message }),
    };
    match CommentCeilings::parse(&value) {
        Ok(ceilings) => Ok(CommentConfigResolution::Resolved(ceilings)),
        Err(CeilingInputError::TypeError(error)) => Err(error),
        Err(CeilingInputError::Issue(issue)) => Ok(CommentConfigResolution::Refused {
            message: invalid_config(&label, &issue),
        }),
    }
}
