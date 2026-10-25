use super::ceilings::{CeilingInputError, CommentCeilings};
use crate::{
    text::{JsString, JsValue},
    validation::{PathSegment, RecordTypeError},
};
use std::{fs, path::Path};

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
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(_) => {
            return Ok(CommentConfigResolution::Refused {
                message: format!("cannot read config file \"{}\".", file.display()).into(),
            });
        }
    };
    let value = match JsValue::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(value) => value,
        Err(_) => {
            return Ok(CommentConfigResolution::Refused {
                message: format!("config file \"{}\" is not valid JSON.", file.display()).into(),
            });
        }
    };
    match CommentCeilings::parse(&value) {
        Ok(ceilings) => Ok(CommentConfigResolution::Resolved(ceilings)),
        Err(CeilingInputError::TypeError(error)) => Err(error),
        Err(CeilingInputError::Issue(issue)) => {
            let mut location = JsString::default();
            for (index, part) in issue.path().iter().enumerate() {
                if index > 0 {
                    location.push_str(".");
                }
                match part {
                    PathSegment::Field(field) => location.extend(field),
                    PathSegment::Index(index) => location.push_str(&index.to_string()),
                }
            }
            if location.is_empty() {
                location.push_str("(root)");
            }
            let mut message = JsString::from(format!("invalid config in \"{}\": ", file.display()));
            message.extend(&location);
            message.push_str(": ");
            message.extend(issue.message());
            message.push_str(".");
            Ok(CommentConfigResolution::Refused { message })
        }
    }
}
