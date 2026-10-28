use crate::{
    api::{base::GitReadFailure, capture_with_limit, real_path},
    project::relative_path_text_from,
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use std::{
    error::Error,
    fmt,
    io::{self, Write},
    process::{Command, Stdio},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChurnWindow {
    pub since_iso: JsString,
    pub until_iso: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub days: f64,
}
#[derive(Debug)]
pub struct ChurnData {
    pub repo_root: JsString,
    pub head_sha: JsString,
    pub commits_by_file: IndexMap<JsString, f64>,
    pub tracked_files: IndexSet<JsString>,
}
#[derive(Debug)]
pub struct HotspotsOptions {
    pub days: f64,
    pub limit: f64,
}
#[derive(Debug)]
pub struct HotspotsOptionError {
    pub flag: &'static str,
    pub raw: JsString,
}
impl HotspotsOptionError {
    pub fn message(&self) -> JsString {
        let mut message = JsString::from(self.flag);
        message.push_str(" expects a non-negative integer, got \"");
        message.extend(&self.raw);
        message.push_str("\".");
        message
    }
}
impl fmt::Display for HotspotsOptionError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.message().to_lossy())
    }
}
impl Error for HotspotsOptionError {}
fn nonnegative(raw: &JsString, flag: &'static str) -> Result<f64, HotspotsOptionError> {
    let trimmed = raw.trim_js();
    if trimmed.is_empty() || !trimmed.units().iter().all(|unit| (48..=57).contains(unit)) {
        return Err(HotspotsOptionError {
            flag,
            raw: raw.clone(),
        });
    }
    // Validation leaves only ASCII decimal digits; overflow is Number Infinity.
    Ok(trimmed
        .to_utf8()
        .expect("ASCII digits")
        .parse::<f64>()
        .expect("nonempty ASCII decimal digits form an f64, including overflow"))
}
pub fn resolve_hotspots_cli_options(
    days: &JsString,
    limit: &JsString,
) -> Result<HotspotsOptions, HotspotsOptionError> {
    let days = nonnegative(days, "--hotspots-days")?;
    let limit = nonnegative(limit, "--hotspots-limit")?;
    Ok(HotspotsOptions { days, limit })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChurnStage {
    RealRoot,
    RepositoryRoot,
    Head,
    TrackedFiles,
    Log,
}
impl ChurnStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RealRoot => "real-root",
            Self::RepositoryRoot => "top",
            Self::Head => "head",
            Self::TrackedFiles => "tracked",
            Self::Log => "log",
        }
    }
}
#[derive(Debug)]
pub enum ChurnFailure {
    Io {
        stage: ChurnStage,
        path: JsString,
        source: io::Error,
    },
    Git {
        stage: ChurnStage,
        read: Box<GitReadFailure>,
    },
    Diagnostic {
        stage: ChurnStage,
        read: Box<GitReadFailure>,
        source: io::Error,
    },
}
impl ChurnFailure {
    pub fn stage(&self) -> ChurnStage {
        match self {
            Self::Io { stage, .. } | Self::Git { stage, .. } | Self::Diagnostic { stage, .. } => {
                *stage
            }
        }
    }
}
impl fmt::Display for ChurnFailure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            out,
            "hotspots Git history unavailable at {}",
            self.stage().as_str()
        )
    }
}
impl Error for ChurnFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(match self {
            Self::Io { source, .. } | Self::Diagnostic { source, .. } => source as &dyn Error,
            Self::Git { read, .. } => read.as_ref() as &dyn Error,
        })
    }
}
fn run_git(
    cwd: &JsString,
    arguments: Vec<JsString>,
    stage: ChurnStage,
    diagnostic: &mut impl FnMut(&JsString) -> io::Result<()>,
) -> Result<GitReadFailure, ChurnFailure> {
    let mut command = Command::new("git");
    command
        .args(arguments.iter().map(JsString::to_lossy))
        .current_dir(cwd.to_lossy())
        .stdin(Stdio::null());
    let captured = capture_with_limit(&mut command, 64 * 1024 * 1024);
    let read = GitReadFailure {
        cwd: cwd.clone(),
        arguments,
        stdout: captured.stdout,
        stderr: captured.stderr,
        status: captured.status,
        failures: captured.failures,
    };
    // execFileSync with encoding:utf8 forwards stderr before checking the result,
    // even for successful children. Keep original bytes in the native read data.
    if !read.stderr.is_empty()
        && let Err(source) = diagnostic(&text(&read.stderr))
    {
        return Err(ChurnFailure::Diagnostic {
            stage,
            read: Box::new(read),
            source,
        });
    }
    if !read.failures.is_empty() || !read.status.is_some_and(|status| status.success()) {
        return Err(ChurnFailure::Git {
            stage,
            read: Box::new(read),
        });
    }
    Ok(read)
}
fn text(bytes: &[u8]) -> JsString {
    String::from_utf8_lossy(bytes).as_ref().into()
}
fn relative(prefix: &JsString, file: &JsString) -> Option<JsString> {
    if prefix.is_empty() {
        return Some(file.clone());
    }
    file.units()
        .strip_prefix(prefix.units())
        .and_then(|rest| rest.strip_prefix(&[47][..]))
        .map(|units| JsString::from_units(units.to_vec()))
}
fn tracked(output: &JsString, prefix: &JsString) -> IndexSet<JsString> {
    output
        .units()
        .split(|unit| *unit == 10)
        .filter(|line| !line.is_empty())
        .filter_map(|line| relative(prefix, &JsString::from_units(line.to_vec())))
        .collect()
}
fn counts(output: &JsString, prefix: &JsString) -> IndexMap<JsString, f64> {
    let mut result = IndexMap::new();
    for chunk in output.units().split(|unit| *unit == 0) {
        let mut files_in_commit = IndexSet::new();
        for line in chunk.split(|unit| *unit == 10) {
            let line = JsString::from_units(line.to_vec()).trim_js();
            if line.is_empty() {
                continue;
            }
            if let Some(file) = relative(prefix, &line)
                && files_in_commit.insert(file.clone())
            {
                *result.entry(file).or_insert(0.0) += 1.0;
            }
        }
    }
    result
}
/// Blocking Git reads. An Err corresponds to the Source helper's null on the
/// compared profile; the actual native cause and child bytes remain inspectable.
pub fn load_churn_blocking(
    root: &JsString,
    window: &ChurnWindow,
) -> Result<ChurnData, ChurnFailure> {
    load_churn_with_diagnostic(root, window, &mut |payload| {
        io::stderr().write_all(payload.to_lossy().as_bytes())
    })
}

pub(crate) fn load_churn_with_diagnostic(
    root: &JsString,
    window: &ChurnWindow,
    diagnostic: &mut impl FnMut(&JsString) -> io::Result<()>,
) -> Result<ChurnData, ChurnFailure> {
    let real = real_path(root).map_err(|source| ChurnFailure::Io {
        stage: ChurnStage::RealRoot,
        path: root.clone(),
        source,
    })?;
    let top = run_git(
        &real,
        vec!["rev-parse".into(), "--show-toplevel".into()],
        ChurnStage::RepositoryRoot,
        diagnostic,
    )?;
    let repo_root = text(&top.stdout).trim_js();
    if repo_root.is_empty() {
        return Err(ChurnFailure::Git {
            stage: ChurnStage::RepositoryRoot,
            read: Box::new(top),
        });
    }
    let head = run_git(
        &real,
        vec!["rev-parse".into(), "HEAD".into()],
        ChurnStage::Head,
        diagnostic,
    )?;
    let head_sha = text(&head.stdout).trim_js();
    if head_sha.is_empty() {
        return Err(ChurnFailure::Git {
            stage: ChurnStage::Head,
            read: Box::new(head),
        });
    }
    let prefix = relative_path_text_from(&repo_root, &real).map_err(|source| ChurnFailure::Io {
        stage: ChurnStage::RepositoryRoot,
        path: repo_root.clone(),
        source,
    })?;
    let pathspec = if prefix.is_empty() {
        vec![]
    } else {
        vec![JsString::from("--"), prefix.clone()]
    };
    let mut args = vec![JsString::from("ls-files")];
    args.extend(pathspec.iter().cloned());
    let tracked = run_git(&repo_root, args, ChurnStage::TrackedFiles, diagnostic)?;
    let mut since = JsString::from("--since=");
    since.extend(&window.since_iso);
    let mut until = JsString::from("--until=");
    until.extend(&window.until_iso);
    let mut args = vec![
        JsString::from("log"),
        since,
        until,
        "--name-only".into(),
        "--pretty=format:%x00".into(),
    ];
    args.extend(pathspec);
    let log = run_git(&repo_root, args, ChurnStage::Log, diagnostic)?;
    Ok(ChurnData {
        repo_root,
        head_sha,
        commits_by_file: counts(&text(&log.stdout), &prefix),
        tracked_files: self::tracked(&text(&tracked.stdout), &prefix),
    })
}
pub fn churn_for(churn: &ChurnData, file: &JsString) -> Option<f64> {
    if !churn.tracked_files.contains(file) {
        return None;
    }
    Some(churn.commits_by_file.get(file).copied().unwrap_or(0.0))
}
