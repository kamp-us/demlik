use demlik_code_graph::{
    comments::{
        census::CommentCensus,
        classify::{BucketRecord, CommentBucket, CommentClass, CommentShape},
    },
    text::JsString,
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
};
macro_rules! observe { ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{ let returned = $function($($argument),*); $calls.push(stringify!($function)); returned }}; }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ShapeInput {
    text: JsString,
    #[serde(default = "default_pos")]
    pos: usize,
    #[serde(default)]
    file_header_candidate: bool,
}
fn default_pos() -> usize {
    100
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CensusInput {
    root: PathBuf,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShapeOutput {
    body: JsString,
    banner: bool,
    commented_out_code: bool,
    bucket: CommentBucket,
    class: CommentClass,
}
#[derive(Serialize)]
struct GovernedRatio<'a> {
    scope: &'a str,
    ratio: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CensusOutput<'a> {
    census: &'a CommentCensus,
    governed_ratios: Vec<GovernedRatio<'a>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BucketOutput {
    buckets: [CommentBucket; 9],
    classes: BucketRecord<CommentClass>,
    protected: Vec<CommentBucket>,
    mechanical: Vec<CommentBucket>,
    prose: Vec<CommentBucket>,
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
impl DriverError {
    fn transport(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "driver-error",
            message: error.to_string(),
        }
    }
    fn backend(error: impl std::fmt::Display) -> Self {
        Self {
            kind: "backend-error",
            message: error.to_string(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DriverError>,
    observed_calls: Vec<&'static str>,
}
fn input<T: for<'a> Deserialize<'a>>(raw: &RawValue) -> Result<T, DriverError> {
    serde_json::from_str(raw.get()).map_err(DriverError::transport)
}
fn execute(case: Case, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, DriverError> {
    match case.operation.as_str() {
        "code_graph.comment_classify" => {
            let input: ShapeInput = input(&case.input)?;
            let body = observe!(
                calls,
                demlik_code_graph::comments::classify::comment_body,
                &input.text
            );
            let banner = observe!(
                calls,
                demlik_code_graph::comments::classify::is_banner,
                &body
            );
            let commented_out_code = observe!(
                calls,
                demlik_code_graph::comments::classify::is_commented_out_code,
                &body
            )
            .map_err(DriverError::backend)?;
            let bucket = observe!(
                calls,
                demlik_code_graph::comments::classify::classify_comment,
                CommentShape {
                    text: &input.text,
                    pos: input.pos,
                    file_header_candidate: input.file_header_candidate
                }
            )
            .map_err(DriverError::backend)?;
            let class = observe!(
                calls,
                demlik_code_graph::comments::classify::CommentBucket::class,
                bucket
            );
            to_raw_value(&ShapeOutput {
                body,
                banner,
                commented_out_code,
                bucket,
                class,
            })
            .map_err(DriverError::transport)
        }
        "code_graph.comment_census" => {
            let input: CensusInput = input(&case.input)?;
            let census = observe!(
                calls,
                demlik_code_graph::comments::census::load_comment_census,
                &input.root
            )
            .map_err(DriverError::backend)?;
            let governed_ratios = census
                .scopes
                .iter()
                .map(|scope| GovernedRatio {
                    scope: &scope.scope,
                    ratio: observe!(
                        calls,
                        demlik_code_graph::comments::census::governed_ratio,
                        scope
                    ),
                })
                .collect();
            to_raw_value(&CensusOutput {
                census: &census,
                governed_ratios,
            })
            .map_err(DriverError::transport)
        }
        "code_graph.comment_buckets" => {
            let _: EmptyInput = input(&case.input)?;
            let mut classes = BucketRecord::new(|| CommentClass::Prose);
            for bucket in CommentBucket::ALL {
                classes[bucket] = observe!(
                    calls,
                    demlik_code_graph::comments::classify::CommentBucket::class,
                    bucket
                );
            }
            let protected = observe!(
                calls,
                demlik_code_graph::comments::classify::buckets_in,
                CommentClass::Protected
            )
            .collect();
            let mechanical = observe!(
                calls,
                demlik_code_graph::comments::classify::buckets_in,
                CommentClass::Mechanical
            )
            .collect();
            let prose = observe!(
                calls,
                demlik_code_graph::comments::classify::buckets_in,
                CommentClass::Prose
            )
            .collect();
            to_raw_value(&BucketOutput {
                buckets: CommentBucket::ALL,
                classes,
                protected,
                mechanical,
                prose,
            })
            .map_err(DriverError::transport)
        }
        _ => Err(DriverError::transport(format!(
            "unsupported operation: {}",
            case.operation
        ))),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let parsed = serde_json::from_str::<Case>(&line?);
        let id = parsed.as_ref().map(|case| case.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = parsed
            .map_err(DriverError::transport)
            .and_then(|case| execute(case, &mut observed_calls));
        let response = match result {
            Ok(output) => Response {
                id,
                ok: true,
                output: Some(output),
                error: None,
                observed_calls,
            },
            Err(error) => Response {
                id,
                ok: false,
                output: None,
                error: Some(error),
                observed_calls,
            },
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
