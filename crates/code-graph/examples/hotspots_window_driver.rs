use demlik_code_graph::{
    hotspots::{ChurnWindow, ChurnWindowError, WindowDate},
    text::JsString,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    cell::Cell,
    error::Error,
    io::{self, Read, Write},
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(decoder: D) -> Result<Option<T>, D::Error> {
    T::deserialize(decoder).map(Some)
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Value(f64),
    Special(String),
}
impl Number {
    fn value(&self) -> Result<f64, &'static str> {
        Ok(match self {
            Self::Value(value) => *value,
            Self::Special(value) => match value.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => return Err("unsupported numeric marker"),
            },
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    id: String,
    days: Number,
    #[serde(default, deserialize_with = "some")]
    since: Option<JsString>,
    clock_ms: f64,
    zone: JsString,
}
#[derive(Serialize)]
struct ErrorView {
    name: &'static str,
    message: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeErrorData<'a> {
    part: Option<&'static str>,
    value_bits: Option<String>,
    since_input: Option<&'a JsString>,
    source: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    id: &'a str,
    clock_reads: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<&'a ChurnWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_error_data: Option<NativeErrorData<'a>>,
    zone_id: &'a JsString,
    timezone_data_version: &'a str,
    native_trace: Vec<&'static str>,
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    let days = request.days.value()?;
    let mut calls = Vec::new();
    let zone = observe!(
        calls,
        demlik_code_graph::hotspots::LocalTimeZone::try_named,
        &request.zone
    )?;
    let reads = Cell::new(0);
    let result = observe!(
        calls,
        demlik_code_graph::hotspots::resolve_churn_window,
        days,
        request.since.as_ref(),
        || {
            reads.set(reads.get() + 1);
            request.clock_ms
        },
        &zone
    );
    let zone_id = observe!(calls, demlik_code_graph::hotspots::LocalTimeZone::id, &zone);
    let version = observe!(
        calls,
        demlik_code_graph::hotspots::LocalTimeZone::data_version,
        &zone
    );
    let (output, error, native_error_data) = match &result {
        Ok(output) => (Some(output), None, None),
        Err(error) => {
            let (part, value_bits, since_input) = match error {
                ChurnWindowError::InvalidTimeValue(value) => (
                    Some(match value.part {
                        WindowDate::Since => "since",
                        WindowDate::Until => "until",
                    }),
                    Some(format!("{:016x}", value.value.to_bits())),
                    value.since_input.as_ref(),
                ),
                ChurnWindowError::TimeZone(_) => (None, None, None),
            };
            (
                None,
                Some(ErrorView {
                    name: error.name(),
                    message: error.message(),
                }),
                Some(NativeErrorData {
                    part,
                    value_bits,
                    since_input,
                    source: error.source().expect("original typed cause").to_string(),
                }),
            )
        }
    };
    let response = Response {
        id: &request.id,
        clock_reads: reads.get(),
        output,
        error,
        native_error_data,
        zone_id,
        timezone_data_version: version,
        native_trace: calls,
    };
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
