use crate::{schema::Graph, text::JsString};
pub fn render_graph(graph: &Graph, pretty: bool) -> Result<JsString, serde_json::Error> {
    super::json::stable_stringify(graph, pretty).map(Into::into)
}
