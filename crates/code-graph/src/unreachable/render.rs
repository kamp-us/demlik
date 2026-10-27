use super::ledger::{
    UNREACHABLE_LEDGER_FILENAME, UnreachableFinding, UnreachableLedgerEntry,
    UnreachableReconciliation,
};
use crate::{render::json::stable_stringify, text::JsString};
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachableRender {
    pub stdout: JsString,
    pub exit_code: i32,
}
fn finding_line(finding: &UnreachableFinding) -> JsString {
    let mut line = JsString::from("  ");
    line.push_str(finding.kind.as_str());
    line.push_str("  ");
    line.extend(&finding.id);
    line
}
fn pruned_lines(pruned: &[Arc<UnreachableLedgerEntry>]) -> Vec<JsString> {
    if pruned.is_empty() {
        return vec![];
    }
    let count = pruned.len();
    let mut lines = vec![
        format!(
            "pruned {count} entr{} from {UNREACHABLE_LEDGER_FILENAME} — the finding is gone:",
            if count == 1 { "y" } else { "ies" },
        )
        .into(),
    ];
    lines.extend(pruned.iter().map(|entry| finding_line(&entry.finding)));
    lines
}
fn joined(lines: &[JsString]) -> JsString {
    let mut text = JsString::default();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            text.push_str("\n");
        }
        text.extend(line);
    }
    text
}
pub fn render_unreachable_gate(
    result: &UnreachableReconciliation<'_>,
    json: bool,
    pretty: bool,
) -> Result<UnreachableRender, serde_json::Error> {
    let passed = result.unrecorded.is_empty();
    let exit_code = if passed { 0 } else { 1 };
    if json {
        #[derive(Serialize)]
        struct Wire<'a, 'f> {
            passed: bool,
            scope: &'a JsString,
            gated: &'a [crate::schema::UnreachableCategory],
            unrecorded: &'a [&'f UnreachableFinding],
            pruned: &'a [Arc<UnreachableLedgerEntry>],
        }
        return Ok(UnreachableRender {
            stdout: stable_stringify(
                &Wire {
                    passed,
                    scope: result.scope,
                    gated: result.gated,
                    unrecorded: &result.unrecorded,
                    pruned: &result.pruned,
                },
                pretty,
            )?
            .into(),
            exit_code,
        });
    }
    let recorded = result
        .kept
        .entries
        .iter()
        .filter(|entry| entry.finding.scope == *result.scope)
        .count();
    let mut head = if passed {
        let mut line = JsString::from("unreachable ledger: PASS — scope ");
        line.extend(result.scope);
        line.push_str(&format!(", {recorded} recorded finding(s), none new."));
        vec![line]
    } else {
        let mut line = JsString::from(format!(
            "UNREACHABLE LEDGER FAILED — {} finding(s) in scope ",
            result.unrecorded.len()
        ));
        line.extend(result.scope);
        line.push_str(&format!(" not in {UNREACHABLE_LEDGER_FILENAME}:"));
        let mut lines = vec![line];
        lines.extend(
            result
                .unrecorded
                .iter()
                .map(|finding| finding_line(finding)),
        );
        lines.push("Delete or use each export, or record it by name: --unreachable --accept-dead --reason \"<why>\".".into());
        lines
    };
    head.extend(pruned_lines(&result.pruned));
    Ok(UnreachableRender {
        stdout: joined(&head),
        exit_code,
    })
}
pub fn render_accepted_dead(
    result: &UnreachableReconciliation<'_>,
    reason: &JsString,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        #[derive(Serialize)]
        struct Wire<'a, 'f> {
            scope: &'a JsString,
            accepted: &'a [&'f UnreachableFinding],
            pruned: &'a [Arc<UnreachableLedgerEntry>],
            reason: &'a JsString,
        }
        return Ok(stable_stringify(
            &Wire {
                scope: result.scope,
                accepted: &result.unrecorded,
                pruned: &result.pruned,
                reason,
            },
            pretty,
        )?
        .into());
    }
    let mut lines = if result.unrecorded.is_empty() {
        vec![JsString::from(
            "accept-dead: no unrecorded finding — nothing to add.",
        )]
    } else {
        let mut line = JsString::from(format!(
            "accepted {} finding(s) of scope ",
            result.unrecorded.len()
        ));
        line.extend(result.scope);
        line.push_str(&format!(" into {UNREACHABLE_LEDGER_FILENAME}, reason \""));
        line.extend(reason);
        line.push_str("\":");
        let mut lines = vec![line];
        lines.extend(
            result
                .unrecorded
                .iter()
                .map(|finding| finding_line(finding)),
        );
        lines
    };
    lines.extend(pruned_lines(&result.pruned));
    Ok(joined(&lines))
}
