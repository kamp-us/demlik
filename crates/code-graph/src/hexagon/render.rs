use super::{ports::HexagonMember, read::Hexagon};
use crate::{
    render::{json::stable_stringify, text::number},
    text::JsString,
};
fn joined(lines: Vec<JsString>, separator: &str) -> JsString {
    let mut result = JsString::default();
    for (index, line) in lines.into_iter().enumerate() {
        if index > 0 {
            result.push_str(separator);
        }
        result.extend(&line);
    }
    result
}
fn members_text(members: &[HexagonMember]) -> Vec<JsString> {
    members
        .iter()
        .map(|member| {
            let mut line = JsString::from("  ");
            line.extend(&member.name);
            line.push_str(": ");
            line.extend(&member.type_text);
            if let Some(signature) = &member.signature
                && signature != &member.type_text
            {
                line.push_str(" = ");
                line.extend(signature);
            }
            line
        })
        .collect()
}
fn section(title: &str, lines: Vec<JsString>, empty: &str) -> JsString {
    let mut result = JsString::from(title);
    result.push_str("\n");
    if lines.is_empty() {
        result.push_str(empty);
    } else {
        result.extend(&joined(lines, "\n"));
    }
    result
}
pub fn render_hexagon(
    report: &Hexagon,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        return stable_stringify(report, pretty).map(JsString::from);
    }
    let mut title = JsString::from(if report.feature.is_some() {
        "Hexagon: "
    } else {
        "Factory: not found"
    });
    if let Some(feature) = &report.feature {
        title.extend(feature);
    }
    let mut other_bags = Vec::new();
    for bag in &report.other_bags {
        let mut name = JsString::from("  ");
        name.extend(&bag.name);
        other_bags.push(name);
        if bag.members.is_empty() {
            other_bags.push("    none".into());
        }
        for member in members_text(&bag.members) {
            let mut line = JsString::from("  ");
            line.extend(&member);
            other_bags.push(line);
        }
    }
    let ports = report
        .unbagged_ports
        .iter()
        .map(|port| {
            let mut line = JsString::from("  ");
            line.extend(&port.name);
            line.push_str(": ");
            line.extend(&port.type_text);
            line
        })
        .collect();
    let cases = report
        .use_cases
        .iter()
        .map(|case| {
            let mut line = JsString::from("  ");
            line.extend(&case.file);
            line.push_str(": ");
            if case.functions.is_empty() {
                line.push_str("none");
            } else {
                line.extend(&joined(case.functions.clone(), ", "));
            }
            line
        })
        .collect();
    let adapter_lines = |files: &[JsString]| {
        files
            .iter()
            .map(|file| {
                let mut line = JsString::from("    ");
                line.extend(file);
                line
            })
            .collect()
    };
    let not_read = report
        .not_read
        .iter()
        .map(|item| {
            let mut line = JsString::from("  ");
            line.extend(&item.file);
            line.push_str(":");
            line.push_str(&number(item.line));
            line.push_str(" ");
            line.extend(&item.name);
            line.push_str(": ");
            line.extend(&item.reason);
            line
        })
        .collect();
    Ok(joined(
        vec![
            title,
            section("Commands", members_text(&report.commands), "  none"),
            section(
                "External systems",
                members_text(&report.external_systems),
                "  none",
            ),
            section("Other bags", other_bags, "  none"),
            section("Ports declared in ports.ts but in no bag", ports, "  none"),
            section("Use cases", cases, "  none"),
            section(
                "Adapters",
                vec![
                    section(
                        "  driving",
                        adapter_lines(&report.adapters.driving),
                        "    none",
                    ),
                    section(
                        "  driven",
                        adapter_lines(&report.adapters.driven),
                        "    none",
                    ),
                ],
                "  none",
            ),
            section("Not read", not_read, "  none"),
        ],
        "\n\n",
    ))
}
