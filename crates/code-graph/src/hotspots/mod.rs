//! Churn and hotspot reports for an explicitly supplied window. Date grammar and
//! command-line dispatch stay with their future callers.
mod churn;
mod render;

pub use churn::{
    ChurnData, ChurnFailure, ChurnStage, ChurnWindow, HotspotsOptionError, HotspotsOptions,
    churn_for, load_churn_blocking, resolve_hotspots_cli_options,
};
pub use render::{
    HotspotRow, compute_hotspots, compute_hotspots_from_parts, render_hotspot_rows, render_hotspots,
};
