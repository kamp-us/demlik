use crate::{
    render::{
        json::stable_stringify,
        text::{join, number},
    },
    schema::{DataAccess, DataSite, Graph},
    text::JsString,
};
fn site_text(site: &DataSite) -> JsString {
    let mut line = site.owner_service.clone();
    line.push_str(".env.");
    line.extend(&site.binding);
    if let Some(method) = &site.method {
        line.push_str(".");
        line.extend(method);
        line.push_str("()");
    }
    line.push_str(&format!(
        " [{}] {}",
        site.binding_kind.as_str(),
        site.access.as_str()
    ));
    line
}
pub fn render_data(graph: &Graph, json: bool, pretty: bool) -> Result<JsString, serde_json::Error> {
    let Some(report) = &graph.data else {
        return Ok("data: pass did not run — add --data.".into());
    };
    if json {
        return stable_stringify(report, pretty).map(Into::into);
    }
    let mut counts = [0usize; 3];
    for edge in &report.edges {
        counts[match edge.site.access {
            DataAccess::Read => 0,
            DataAccess::Write => 1,
            DataAccess::Unknown => 2,
        }] += 1;
    }
    let mut lines=vec![format!("data: {} binding access sites ({} read, {} write, {} unknown) from {} wrangler configs; {} unattributed (no named function holds them)",number(report.edges.len() as f64),number(counts[0] as f64),number(counts[1] as f64),number(counts[2] as f64),number(report.config_files.len() as f64),number(report.unattributed.len() as f64)).into()];
    lines.extend(
        report
            .unparsed_configs
            .iter()
            .map(|file| format!("  UNPARSED CONFIG  {file}").into()),
    );
    for edge in &report.edges {
        let mut line = JsString::from(format!(
            "  {}:{}  ",
            edge.function_id,
            number(edge.site.line as f64)
        ));
        line.extend(&site_text(&edge.site));
        lines.push(line);
    }
    for site in &report.unattributed {
        let mut line = JsString::from(format!(
            "  UNATTRIBUTED  {}:{}:{}  ",
            site.file,
            number(site.site.line as f64),
            number(site.site.column as f64)
        ));
        line.extend(&site_text(&site.site));
        lines.push(line);
    }
    Ok(join(lines, "\n"))
}
