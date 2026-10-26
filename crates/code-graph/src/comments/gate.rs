use super::{
    ceilings::{CEILINGS_FILENAME, ceilings_from_census},
    census::load_comment_census,
    config::{CommentConfigResolution, resolve_comment_ceilings, resolve_comment_ceilings_text},
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
#[derive(Debug, Clone, Copy)]
pub(crate) struct CommentGateTextArgs<'a> {
    pub root_absolute: &'a JsString,
    pub repo_root: &'a JsString,
    pub ci: bool,
    pub write_ceilings: bool,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
impl CommentGateError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Record(error) => error.name(),
            Self::Census(_) | Self::Json(_) | Self::Write { .. } => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Record(error) => error.message().clone(),
            Self::Census(_) | Self::Json(_) | Self::Write { .. } => self.to_string().into(),
        }
    }
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
    run(args, None)
}
pub(crate) fn run_comment_gate_text(
    args: CommentGateTextArgs<'_>,
) -> Result<CommentGateResult, CommentGateError> {
    let root_native = args.root_absolute.to_lossy();
    let repo_native = args.repo_root.to_lossy();
    run(
        CommentGateArgs {
            root_absolute: Path::new(&root_native),
            repo_root: Path::new(&repo_native),
            ci: args.ci,
            write_ceilings: args.write_ceilings,
            json: args.json,
            pretty: args.pretty,
        },
        Some(args.repo_root),
    )
}
fn run(
    args: CommentGateArgs<'_>,
    logical_repo: Option<&JsString>,
) -> Result<CommentGateResult, CommentGateError> {
    if !args.ci && !args.write_ceilings {
        let census = load_comment_census(args.root_absolute)?;
        return Ok(CommentGateResult {
            emitted: vec![
                format!("{}\n", render_comments(&census, args.json, args.pretty)?).into(),
            ],
            ..CommentGateResult::default()
        });
    }
    let native_repo = JsString::from(args.repo_root.to_string_lossy().as_ref());
    let text = join_path_text(
        logical_repo.unwrap_or(&native_repo),
        &CEILINGS_FILENAME.into(),
    );
    let file = PathBuf::from(text.to_lossy());
    let requested = file.exists() || args.ci;
    let resolved = match logical_repo {
        Some(_) => resolve_comment_ceilings_text(requested.then_some(&text)),
        None => resolve_comment_ceilings(requested.then_some(file.as_path())),
    }?;
    let ceilings = match resolved {
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
        let mut acknowledgement = JsString::from(format!(
            "wrote {} scope ceiling(s) to ",
            recorded.scopes.len()
        ));
        acknowledgement.extend(&text);
        acknowledgement.push_str("\n");
        return Ok(CommentGateResult {
            emitted: vec![acknowledgement],
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
