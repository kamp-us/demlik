//! Churn windows, Git reads and hotspot reports.
mod churn;
mod date;
mod render;
mod timezone;
mod window;

pub(crate) use churn::load_churn_with_diagnostic;
pub use churn::{
    ChurnData, ChurnFailure, ChurnStage, ChurnWindow, HotspotsOptionError, HotspotsOptions,
    churn_for, load_churn_blocking, resolve_hotspots_cli_options,
};
pub use render::{
    HotspotRow, compute_hotspots, compute_hotspots_from_parts, render_hotspot_rows, render_hotspots,
};
pub use timezone::{LocalTimeZone, TimeZoneError, TimeZoneIcuError};
pub use window::{ChurnWindowError, InvalidTimeValue, WindowDate, resolve_churn_window};
pub(crate) use window::{resolve_churn_window_local, system_clock_ms};
