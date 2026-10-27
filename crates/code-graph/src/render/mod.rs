pub mod analysis;
pub mod ci;
pub mod file;
pub mod graph;
pub mod json;
pub mod plan;
pub mod smells;
pub mod summary;
pub(crate) mod text;

#[derive(Debug)]
pub enum ReportRenderError {
    Io(std::io::Error),
    Json(serde_json::Error),
}
impl From<std::io::Error> for ReportRenderError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<serde_json::Error> for ReportRenderError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}
impl std::fmt::Display for ReportRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for ReportRenderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Io(error) => error,
            Self::Json(error) => error,
        })
    }
}
