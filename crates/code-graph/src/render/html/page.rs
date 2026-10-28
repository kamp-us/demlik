use super::{HtmlModel, HtmlSeverity};
use crate::{
    render::{ReportRenderError, json::stable_stringify},
    schema::{Graph, Health},
    text::JsString,
};
const STYLE: &str = include_str!("assets/style.css.txt");
const CLIENT: &str = include_str!("assets/client.js.txt");
const SECTIONS: &str = include_str!("assets/sections.html.txt");
fn escaped(value: &JsString) -> JsString {
    let mut out = Vec::new();
    for &unit in value.units() {
        match unit {
            38 => out.extend("&amp;".encode_utf16()),
            60 => out.extend("&lt;".encode_utf16()),
            62 => out.extend("&gt;".encode_utf16()),
            34 => out.extend("&quot;".encode_utf16()),
            _ => out.push(unit),
        }
    }
    JsString::from_units(out)
}
pub(super) fn render_page(
    graph: &Graph,
    model: &HtmlModel<'_>,
) -> Result<JsString, ReportRenderError> {
    let fallback = JsString::from(".");
    let root = if graph.root.is_empty() {
        &fallback
    } else {
        &graph.root
    };
    let root = escaped(root);
    let (health, severity) = match model.summary.health {
        Health::Healthy => ("healthy", HtmlSeverity::None),
        Health::Rough => ("rough", HtmlSeverity::Warn),
        Health::Rotten => ("rotten", HtmlSeverity::High),
    };
    let mut out = JsString::from(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n<title>code-graph -- ",
    );
    out.extend(&root);
    out.push_str("</title>\n  <script src=\"https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js\"></script>\n  <script src=\"https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js\"></script>\n  <script src=\"https://cdn.jsdelivr.net/npm/layout-base@2.0.1/layout-base.min.js\"></script>\n  <script src=\"https://cdn.jsdelivr.net/npm/cose-base@2.2.0/cose-base.min.js\"></script>\n  <script src=\"https://cdn.jsdelivr.net/npm/cytoscape-fcose@2.2.0/cytoscape-fcose.min.js\"></script>\n");
    out.push_str(STYLE);
    out.push_str("\n</head>\n<body>\n<header>\n  <h1>");
    out.extend(&root);
    out.push_str(&format!(" &middot;\n    <span class=\"chip\" style=\"background:{}\">{health}</span></h1>\n  <div class=\"meta\">\n    {} files &middot; {} fns &middot;\n    {} smells ({} high)\n    &middot; worst fn: <code>",severity.color(),model.summary.file_count,model.summary.function_count,model.summary.smell_count,model.summary.high_severity_count));
    out.extend(&escaped(&JsString::from(
        model.summary.worst_function.as_deref().unwrap_or("-"),
    )));
    out.push_str("</code>\n    &middot; worst file: <code>");
    out.extend(&escaped(&JsString::from(
        model.summary.worst_file.as_deref().unwrap_or("-"),
    )));
    out.push_str("</code>\n  </div>\n</header>\n\n");
    out.push_str(SECTIONS);
    out.push_str("\n\n<script>\nconst DATA = ");
    out.push_str(&stable_stringify(model, false)?);
    out.push_str(";\n\n");
    out.push_str(CLIENT);
    out.push_str("\n</script>\n</body>\n</html>\n");
    Ok(out)
}
