use super::{
    read::{HexagonReadError, read_hexagon},
    render::render_hexagon,
};
use crate::{
    api::{
        cli::{ApiEmit, ApiReport},
        map::ApiError,
    },
    text::JsString,
};

pub struct HexagonOutput<'a> {
    pub json: bool,
    pub pretty: bool,
    pub emit: &'a mut ApiEmit<'a>,
    pub report: &'a mut ApiReport<'a>,
}
#[derive(Debug)]
pub enum HexagonFailure {
    Read(HexagonReadError),
    Render(serde_json::Error),
    Emit(ApiError),
}
impl HexagonFailure {
    pub fn message(&self) -> JsString {
        match self {
            Self::Read(error) => error.message(),
            Self::Render(error) => error.to_string().into(),
            Self::Emit(error) => error.message(),
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Emit(error) => error.name(),
            _ => "Error",
        }
    }
}
impl std::fmt::Display for HexagonFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for HexagonFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Read(error) => error,
            Self::Render(error) => error,
            Self::Emit(error) => error,
        })
    }
}
#[derive(Debug, Default)]
pub struct HexagonRunOutcome {
    pub failure: Option<HexagonFailure>,
}
#[derive(Debug)]
pub struct HexagonRunError {
    pub report: Box<ApiError>,
    pub processing: Box<HexagonFailure>,
}
impl HexagonRunError {
    pub fn name(&self) -> &'static str {
        self.report.name()
    }
    pub fn message(&self) -> JsString {
        self.report.message()
    }
}
impl std::fmt::Display for HexagonRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for HexagonRunError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.report.as_ref())
    }
}
pub fn run_hexagon(
    root: &JsString,
    out: HexagonOutput<'_>,
) -> Result<HexagonRunOutcome, HexagonRunError> {
    let operation = read_hexagon(root)
        .map_err(HexagonFailure::Read)
        .and_then(|report| {
            render_hexagon(&report, out.json, out.pretty).map_err(HexagonFailure::Render)
        })
        .and_then(|mut payload| {
            payload.push_str("\n");
            (out.emit)(&payload).map_err(HexagonFailure::Emit)
        });
    match operation {
        Ok(()) => Ok(HexagonRunOutcome::default()),
        Err(processing) => {
            if let Err(report) = (out.report)(&processing.message()) {
                return Err(HexagonRunError {
                    report: Box::new(report),
                    processing: Box::new(processing),
                });
            }
            Ok(HexagonRunOutcome {
                failure: Some(processing),
            })
        }
    }
}
