use super::EnvKeyReport;
use crate::{
    render::{json::stable_stringify, text::number},
    text::JsString,
};
use indexmap::IndexMap;
pub(crate) fn render_env_keys(
    report: &EnvKeyReport,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        return stable_stringify(report, pretty).map(Into::into);
    }
    let mut out = JsString::from(format!(
        "env-keys: {} declared, {} recognized reads",
        number(report.declared_count),
        number(report.read_count)
    ));
    for file in &report.unparsed_configs {
        out.push_str(&format!("\n  UNPARSED CONFIG  {file}"));
    }
    out.push_str(&format!(
        "\ndeclared, never read ({}):",
        report.declared_unreferenced.len()
    ));
    for f in &report.declared_unreferenced {
        out.push_str("\n  ");
        out.extend(&f.key);
        out.push_str("  ");
        out.extend(&f.service);
        out.push_str(&format!("  {}", f.config_file));
    }
    out.push_str(&format!(
        "\nread, never declared ({}):",
        report.read_not_declared.len()
    ));
    for r in &report.read_not_declared {
        out.push_str("\n  ");
        out.extend(&r.key);
        out.push_str("  ");
        out.extend(&r.service);
        out.push_str("  ");
        out.extend(&r.file);
        out.push_str(&format!(":{}", number(r.line)));
    }
    out.push_str(&format!(
        "\nwithheld ({}) — an unmodelled construct may settle these:",
        report.withheld.len()
    ));
    let mut counts = IndexMap::new();
    for w in &report.withheld {
        *counts.entry(w.reason.as_str()).or_insert(0usize) += 1;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by_key(|(key, _)| *key);
    for (reason, count) in counts {
        out.push_str(&format!("\n  {reason}  {count}"));
    }
    Ok(out)
}
