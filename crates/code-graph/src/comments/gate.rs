use super::{
    ceilings::{CEILINGS_FILENAME, ceilings_from_census},
    census::load_comment_census,
    config::{CommentConfigResolution, resolve_comment_ceilings},
    ratchet::{evaluate_ratchet, render_ratchet},
    render::render_comments,
};
use crate::{
    engine::oxc::ParseFailure, project::join_path_text, render::json::stable_stringify,
    text::JsString, validation::RecordTypeError,
};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy)]
pub struct CommentGateArgs<'a> {
    pub root_absolute: &'a Path,
    pub repo_root: &'a Path,
    pub ci: bool,
    pub write_ceilings: bool,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug, Default)]
pub struct CommentGateResult {
    pub exit_code: u8,
    pub emitted: Vec<JsString>,
    pub reports: Vec<JsString>,
}
#[derive(Debug)]
pub enum CommentGateError {
    Census(ParseFailure),
    Json(serde_json::Error),
    Record(RecordTypeError),
    Write { file: PathBuf, source: io::Error },
}
impl std::fmt::Display for CommentGateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Census(error) => error.fmt(formatter),
            Self::Json(error) => error.fmt(formatter),
            Self::Record(error) => error.fmt(formatter),
            Self::Write { file, source } => {
                write!(formatter, "cannot write \"{}\": {source}", file.display())
            }
        }
    }
}
impl std::error::Error for CommentGateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Census(error) => error,
            Self::Json(error) => error,
            Self::Record(error) => error,
            Self::Write { source, .. } => source,
        })
    }
}
impl From<ParseFailure> for CommentGateError {
    fn from(error: ParseFailure) -> Self {
        Self::Census(error)
    }
}
impl From<serde_json::Error> for CommentGateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}
impl From<RecordTypeError> for CommentGateError {
    fn from(error: RecordTypeError) -> Self {
        Self::Record(error)
    }
}
pub fn run_comment_gate(args: CommentGateArgs<'_>) -> Result<CommentGateResult, CommentGateError> {
    if !args.ci && !args.write_ceilings {
        let census = load_comment_census(args.root_absolute)?;
        return Ok(CommentGateResult {
            emitted: vec![
                format!("{}\n", render_comments(&census, args.json, args.pretty)?).into(),
            ],
            ..CommentGateResult::default()
        });
    }
    let text = join_path_text(
        &args.repo_root.to_string_lossy().as_ref().into(),
        &CEILINGS_FILENAME.into(),
    );
    let file = PathBuf::from(text.to_lossy());
    let ceilings =
        match resolve_comment_ceilings((file.exists() || args.ci).then_some(file.as_path()))? {
            CommentConfigResolution::Resolved(ceilings) => ceilings,
            CommentConfigResolution::Refused { message } => {
                return Ok(CommentGateResult {
                    exit_code: 2,
                    reports: vec![message],
                    emitted: Vec::new(),
                });
            }
        };
    let census = load_comment_census(args.root_absolute)?;
    if args.write_ceilings {
        let recorded = ceilings_from_census(&census, &ceilings);
        let bytes = format!("{}\n", stable_stringify(&recorded, true)?);
        fs::write(&file, bytes).map_err(|source| CommentGateError::Write {
            file: file.clone(),
            source,
        })?;
        return Ok(CommentGateResult {
            emitted: vec![
                format!(
                    "wrote {} scope ceiling(s) to {}\n",
                    recorded.scopes.len(),
                    file.display()
                )
                .into(),
            ],
            ..CommentGateResult::default()
        });
    }
    let mut result = render_ratchet(
        &evaluate_ratchet(&census, &ceilings),
        args.json,
        args.pretty,
    )?;
    result.stdout.push_str("\n");
    Ok(CommentGateResult {
        exit_code: result.exit_code,
        emitted: vec![result.stdout],
        reports: Vec::new(),
    })
}
