mod model;
mod page;
use crate::{project::Collation, render::ReportRenderError, schema::Graph, text::JsString};
pub use model::{
    GraphEdge, GraphNode, HtmlGraph, HtmlModel, HtmlSeverity, TreemapNode, build_html_model,
};
pub fn render_html(graph: &Graph, collation: &Collation) -> Result<JsString, ReportRenderError> {
    page::render_page(graph, &build_html_model(graph, collation)?)
}
