//! The API mode's caller, after the global CLI has parsed its flags. These entry
//! points block on native tooling IO and do not parse arguments or start an executor.
use crate::{
    api::{
        diff::diff_published_api_blocking,
        map::{ApiCallbackError, ApiError, ApiInputError},
        model::VerdictContext,
        ratchet::{
            changesets::{ChangesetsOptions, read_changesets_since},
            policy::bump_policy,
            text::render_api_ratchet,
            verdict::{api_changes, ratchet_api_diff},
        },
        view::{ApiWarning, PublishedApiOptions, read_published_api},
    },
    engine::tsgo::TsgoBinary,
    extract::functions::js_space,
    render::{json::stable_stringify, text::join},
    text::{JsString, JsValue},
};
use std::{error::Error, fs};

pub type ApiEmit<'a> = dyn FnMut(&JsString) -> Result<(), ApiError> + 'a;
pub type ApiReport<'a> = dyn FnMut(&JsString) -> Result<(), ApiError> + 'a;
pub struct ApiHost<'a> {
    pub root_absolute: &'a JsString,
    pub given: &'a [JsString],
    pub json: bool,
    pub pretty: bool,
    pub emit: &'a mut ApiEmit<'a>,
    pub report: &'a mut ApiReport<'a>,
}
pub struct ApiRun<'a> {
    pub host: ApiHost<'a>,
    pub map_file: &'a JsString,
    pub base: Option<&'a JsString>,
    pub policy_file: Option<&'a JsString>,
}
#[derive(Default)]
pub struct ApiFlags<'a> {
    pub api: Option<&'a JsString>,
    pub api_base: Option<&'a JsString>,
    pub api_policy: Option<&'a JsString>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum ApiExit {
    Success = 0,
    RatchetMiss = 1,
    Refused = 2,
    Crash = 3,
}
impl ApiExit {
    pub fn code(self) -> i32 {
        self as i32
    }
}
pub const API_CRASH_EXIT: i32 = 3;
#[derive(Debug)]
pub struct ApiRunOutcome {
    pub exit: ApiExit,
    pub failure: Option<ApiError>,
}
/// A report callback escaped the Source catch boundary. Its error is primary;
/// any processing failure that led to that report remains independently owned.
#[derive(Debug)]
pub struct ApiRunError {
    pub report: Box<ApiError>,
    pub processing: Option<Box<ApiError>>,
}
impl ApiRunError {
    pub fn visible(&self) -> &ApiError {
        self.report.visible()
    }
    pub fn message(&self) -> JsString {
        self.report.message()
    }
}
impl std::fmt::Display for ApiRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.report.fmt(f)
    }
}
impl Error for ApiRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(&*self.report)
    }
}

fn input_message(file: &JsString, what: &str, before: &str, after: &str) -> JsString {
    let mut message = JsString::from(before);
    message.push_str(what);
    message.push_str(" \"");
    message.extend(file);
    message.push_str("\"");
    message.push_str(after);
    message
}
fn read_json_file(file: &JsString, what: &str) -> Result<JsValue, ApiError> {
    let raw = fs::read(file.to_lossy()).map_err(|cause| {
        ApiError::Input(
            ApiInputError::new(input_message(file, what, "cannot read ", "")).with_cause(cause),
        )
    })?;
    JsValue::parse(&String::from_utf8_lossy(&raw)).map_err(|cause| {
        ApiError::Input(
            ApiInputError::new(input_message(file, what, "", " is not valid JSON"))
                .with_cause(cause),
        )
    })
}
fn flag_of(attribute: &JsString) -> JsString {
    let mut out = JsString::from("--");
    for &unit in attribute.units() {
        if (65..=90).contains(&unit) {
            out.push_str("-");
            out.extend(&JsString::from_units(vec![unit + 32]));
        } else {
            out.extend(&JsString::from_units(vec![unit]));
        }
    }
    out
}
fn crash_line(error: &ApiError) -> JsString {
    let message = error.message();
    let mut clean = Vec::new();
    let mut space = false;
    for &unit in message.units() {
        if char::from_u32(u32::from(unit)).is_some_and(js_space) {
            space = !clean.is_empty();
        } else {
            if space {
                clean.push(32);
                space = false;
            }
            clean.push(unit);
        }
    }
    let mut out = JsString::from("unexpected error: ");
    out.extend(&JsString::from_units(clean));
    out
}
fn json_payload(value: &impl serde::Serialize, pretty: bool) -> Result<JsString, ApiError> {
    let mut text = stable_stringify(value, pretty).map_err(|cause| {
        ApiError::Callback(ApiCallbackError::new(cause.to_string().into()).with_cause(cause))
    })?;
    text.push('\n');
    Ok(text.into())
}
struct Outcome {
    payload: JsString,
    exit: ApiExit,
}
fn outcome_of<'warning>(
    run: &ApiRun<'_>,
    compiler: &'warning TsgoBinary,
    options: PublishedApiOptions<'warning>,
) -> Result<Outcome, ApiError> {
    let map = read_json_file(run.map_file, "API map")?;
    if let (Some(base), Some(policy_file)) = (run.base, run.policy_file) {
        let policy_value = read_json_file(policy_file, "bump policy")?;
        let policy = bump_policy(&policy_value)?;
        let diff =
            diff_published_api_blocking(run.host.root_absolute, &map, base, compiler, options)?;
        let changesets = read_changesets_since(
            run.host.root_absolute,
            &diff.base,
            ChangesetsOptions::default(),
        )?;
        let verdict = ratchet_api_diff(&diff, &policy_value, &changesets)?;
        let payload = if run.host.json {
            json_payload(&verdict, run.host.pretty)?
        } else {
            render_api_ratchet(
                &verdict,
                &VerdictContext {
                    changes: api_changes(&diff).len() as f64,
                    callout: policy.callout,
                },
            )
        };
        return Ok(Outcome {
            payload,
            exit: if verdict.passed {
                ApiExit::Success
            } else {
                ApiExit::RatchetMiss
            },
        });
    }
    let payload = match run.base {
        None => json_payload(
            &read_published_api(run.host.root_absolute, &map, compiler, options)?,
            run.host.pretty,
        )?,
        Some(base) => json_payload(
            &diff_published_api_blocking(run.host.root_absolute, &map, base, compiler, options)?,
            run.host.pretty,
        )?,
    };
    Ok(Outcome {
        payload,
        exit: ApiExit::Success,
    })
}
fn report_precondition(
    host: &mut ApiHost<'_>,
    message: &JsString,
) -> Result<ApiRunOutcome, ApiRunError> {
    (host.report)(message).map_err(|report| ApiRunError {
        report: Box::new(report),
        processing: None,
    })?;
    Ok(ApiRunOutcome {
        exit: ApiExit::Refused,
        failure: None,
    })
}

/// Run the already-parsed API mode. Processing and emit failures are reported;
/// report failures escape exactly where the Source caller invokes that callback.
pub fn run_api_view_blocking(
    run: ApiRun<'_>,
    compiler: &TsgoBinary,
) -> Result<ApiRunOutcome, ApiRunError> {
    run_api_view_with_warning(run, compiler, None)
}
fn run_api_view_with_warning<'host, 'warning>(
    mut run: ApiRun<'host>,
    compiler: &'warning TsgoBinary,
    warning: Option<&'warning mut ApiWarning<'warning>>,
) -> Result<ApiRunOutcome, ApiRunError> {
    let stray = run
        .host
        .given
        .iter()
        .filter(|attribute| {
            !["api", "apiBase", "apiPolicy", "json", "pretty", "out"]
                .iter()
                .any(|allowed| *attribute == allowed)
        })
        .map(flag_of)
        .collect::<Vec<_>>();
    if !stray.is_empty() {
        let mut message = JsString::from(
            "--api takes only --api-base, --api-policy, --json, --pretty and --out; got ",
        );
        message.extend(&join(stray, ", "));
        return report_precondition(&mut run.host, &message);
    }
    if run.policy_file.is_some() && run.base.is_none() {
        return report_precondition(&mut run.host, &"--api-policy needs --api-base <rev>".into());
    }
    let result = outcome_of(
        &run,
        compiler,
        PublishedApiOptions {
            repo_root: None,
            warn: warning,
        },
    )
    .and_then(|outcome| {
        (run.host.emit)(&outcome.payload)?;
        Ok(outcome.exit)
    });
    match result {
        Ok(exit) => Ok(ApiRunOutcome {
            exit,
            failure: None,
        }),
        Err(failure) => {
            let (message, exit) = if failure.is_input() {
                (failure.message(), ApiExit::Refused)
            } else {
                (crash_line(&failure), ApiExit::Crash)
            };
            if let Err(report) = (run.host.report)(&message) {
                return Err(ApiRunError {
                    report: Box::new(report),
                    processing: Some(Box::new(failure)),
                });
            }
            Ok(ApiRunOutcome {
                exit,
                failure: Some(failure),
            })
        }
    }
}
/// Return None immediately when the API mode is inactive. Attribute spelling and
/// order come from the future global parser; this function does not infer them.
pub fn run_api_flags_blocking<'a>(
    flags: ApiFlags<'a>,
    host: ApiHost<'a>,
    compiler: &TsgoBinary,
) -> Result<Option<ApiRunOutcome>, ApiRunError> {
    run_api_flags_with_warning_blocking(flags, host, compiler, None)
}
pub(crate) fn run_api_flags_with_warning_blocking<'host, 'warning>(
    flags: ApiFlags<'host>,
    mut host: ApiHost<'host>,
    compiler: &'warning TsgoBinary,
    warning: Option<&'warning mut ApiWarning<'warning>>,
) -> Result<Option<ApiRunOutcome>, ApiRunError> {
    if let Some(map_file) = flags.api {
        return run_api_view_with_warning(
            ApiRun {
                host,
                map_file,
                base: flags.api_base,
                policy_file: flags.api_policy,
            },
            compiler,
            warning,
        )
        .map(Some);
    }
    if flags.api_base.is_none() && flags.api_policy.is_none() {
        return Ok(None);
    }
    let message = if flags.api_base.is_none() {
        "--api-policy needs --api <map> --api-base <rev>"
    } else {
        "--api-base needs --api <map>"
    };
    report_precondition(&mut host, &message.into()).map(Some)
}
