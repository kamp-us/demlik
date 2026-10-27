use super::ledger::{SMELL_LEDGER_FILENAME, SmellChange, SmellFinding, SmellReconciliation};
use crate::{
    render::{
        json::stable_stringify,
        text::{join, number},
    },
    text::JsString,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmellLedgerRender {
    pub stdout: JsString,
    pub exit_code: u8,
}
fn finding_line(finding: &SmellFinding) -> JsString {
    let mut line = JsString::from(format!("  {}  ", finding.rule.as_str()));
    line.extend(&finding.target);
    line.push_str(&format!("  {}", number(finding.value)));
    line
}
fn change_line(change: &SmellChange) -> JsString {
    let mut line = JsString::from(format!("  {}  ", change.rule.as_str()));
    line.extend(&change.target);
    line.push_str(&format!(
        "  recorded {}, measured {}",
        number(change.recorded),
        number(change.measured),
    ));
    line
}
fn entries(count: usize) -> String {
    format!("{count} entr{}", if count == 1 { "y" } else { "ies" })
}
fn written_back_lines(result: &SmellReconciliation<'_>) -> Vec<JsString> {
    let mut lines = vec![];
    if !result.lowered.is_empty() {
        lines.push(
            format!(
                "lowered {} in {SMELL_LEDGER_FILENAME} — the smell shrank:",
                entries(result.lowered.len()),
            )
            .into(),
        );
        lines.extend(result.lowered.iter().map(change_line));
    }
    if !result.pruned.is_empty() {
        lines.push(
            format!(
                "pruned {} from {SMELL_LEDGER_FILENAME} — the smell is gone:",
                entries(result.pruned.len()),
            )
            .into(),
        );
        lines.extend(
            result
                .pruned
                .iter()
                .map(|entry| finding_line(&entry.finding)),
        );
    }
    lines
}
pub fn render_smell_ledger_gate(
    result: &SmellReconciliation<'_>,
    json: bool,
    pretty: bool,
) -> Result<SmellLedgerRender, serde_json::Error> {
    let passed = result.unrecorded.is_empty() && result.worsened.is_empty();
    let exit_code = u8::from(!passed);
    if json {
        #[derive(Serialize)]
        struct Wire<'a, 'f> {
            passed: bool,
            scope: &'a JsString,
            gated: &'a [crate::schema::SmellKind],
            unrecorded: &'a [&'f SmellFinding],
            worsened: &'a [SmellChange],
            lowered: &'a [SmellChange],
            pruned: &'a [std::sync::Arc<super::ledger::SmellLedgerEntry>],
        }
        return Ok(SmellLedgerRender {
            stdout: stable_stringify(
                &Wire {
                    passed,
                    scope: result.scope,
                    gated: result.gated,
                    unrecorded: &result.unrecorded,
                    worsened: &result.worsened,
                    lowered: &result.lowered,
                    pruned: &result.pruned,
                },
                pretty,
            )?
            .into(),
            exit_code,
        });
    }
    let mut head = if passed {
        let mut line = JsString::from("smell ledger: PASS — scope ");
        line.extend(result.scope);
        line.push_str(", gated ");
        line.extend(&join(
            result.gated.iter().map(|kind| kind.as_str().into()),
            ", ",
        ));
        line.push_str(&format!(
            ", {} recorded smell(s), none new or worse.",
            result.kept.entries.len()
        ));
        vec![line]
    } else {
        let mut line = JsString::from("SMELL LEDGER FAILED — scope ");
        line.extend(result.scope);
        line.push_str(", gated ");
        line.extend(&join(
            result.gated.iter().map(|kind| kind.as_str().into()),
            ", ",
        ));
        line.push_str(":");
        let mut lines = vec![line];
        if !result.unrecorded.is_empty() {
            lines.push(
                format!(
                    "{} smell(s) not in {SMELL_LEDGER_FILENAME}:",
                    result.unrecorded.len()
                )
                .into(),
            );
            lines.extend(
                result
                    .unrecorded
                    .iter()
                    .map(|finding| finding_line(finding)),
            );
        }
        if !result.worsened.is_empty() {
            lines.push(
                format!(
                    "{} recorded smell(s) worse than recorded:",
                    result.worsened.len()
                )
                .into(),
            );
            lines.extend(result.worsened.iter().map(change_line));
        }
        lines.push(
            "Shrink each one, or record it by name: --accept-smells --reason \"<why>\".".into(),
        );
        lines
    };
    head.extend(written_back_lines(result));
    Ok(SmellLedgerRender {
        stdout: join(head, "\n"),
        exit_code,
    })
}
pub fn render_accepted_smells(
    result: &SmellReconciliation<'_>,
    reason: &JsString,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        #[derive(Serialize)]
        struct Wire<'a, 'f> {
            scope: &'a JsString,
            gated: &'a [crate::schema::SmellKind],
            accepted: &'a [&'f SmellFinding],
            raised: &'a [SmellChange],
            lowered: &'a [SmellChange],
            pruned: &'a [std::sync::Arc<super::ledger::SmellLedgerEntry>],
            reason: &'a JsString,
        }
        return Ok(stable_stringify(
            &Wire {
                scope: result.scope,
                gated: result.gated,
                accepted: &result.unrecorded,
                raised: &result.worsened,
                lowered: &result.lowered,
                pruned: &result.pruned,
                reason,
            },
            pretty,
        )?
        .into());
    }
    let mut lines = if result.unrecorded.is_empty() && result.worsened.is_empty() {
        vec!["accept-smells: no unrecorded or worsened smell — nothing to add.".into()]
    } else {
        let mut lines = vec![];
        if !result.unrecorded.is_empty() {
            let mut line = JsString::from(format!(
                "accepted {} smell(s) of scope ",
                result.unrecorded.len()
            ));
            line.extend(result.scope);
            line.push_str(&format!(" into {SMELL_LEDGER_FILENAME}, reason \""));
            line.extend(reason);
            line.push_str("\":");
            lines.push(line);
            lines.extend(
                result
                    .unrecorded
                    .iter()
                    .map(|finding| finding_line(finding)),
            );
        }
        if !result.worsened.is_empty() {
            let mut line = JsString::from(format!(
                "raised {} to the measured value, reason \"",
                entries(result.worsened.len())
            ));
            line.extend(reason);
            line.push_str("\":");
            lines.push(line);
            lines.extend(result.worsened.iter().map(change_line));
        }
        lines
    };
    lines.extend(written_back_lines(result));
    Ok(join(lines, "\n"))
}
