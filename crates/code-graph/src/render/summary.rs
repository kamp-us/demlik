use crate::{schema::Graph, text::JsString};
pub fn render_summary(graph: &Graph, pretty: bool) -> Result<JsString, serde_json::Error> {
    super::json::stable_stringify(&graph.summary, pretty).map(Into::into)
}
