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
    let Some(file) = file else {
        return Ok(CommentConfigResolution::Resolved(CommentCeilings::default()));
    };
    let value = match read_config(ConfigFile::Native(file)) {
        Ok(value) => value,
        Err(message) => return Ok(CommentConfigResolution::Refused { message }),
    };
    let file = JsString::from(file.to_string_lossy().as_ref());
    match CommentCeilings::parse(&value) {
        Ok(ceilings) => Ok(CommentConfigResolution::Resolved(ceilings)),
        Err(CeilingInputError::TypeError(error)) => Err(error),
        Err(CeilingInputError::Issue(issue)) => Ok(CommentConfigResolution::Refused {
            message: invalid_config(&file, &issue),
        }),
    }
}
