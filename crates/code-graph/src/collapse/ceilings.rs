use crate::{
    ratchet::scope_count::{
        CeilingDirection, ScopeCountVerdict, has_direction, ratchet_table_lines,
    },
    render::{
        json::stable_stringify,
        text::{join, number},
    },
    text::JsString,
};

pub const CEILINGS_FILENAME: &str = "collapse-ceilings.json";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatchetRender {
    pub stdout: JsString,
    pub exit_code: u8,
}

/// Render one scope-count verdict; the emitting caller owns its terminal newline.
pub fn render_partial_twin_ratchet(
    verdict: &ScopeCountVerdict,
    json: bool,
    pretty: bool,
) -> Result<RatchetRender, serde_json::Error> {
    let exit_code = u8::from(!verdict.passed);
    let stdout = if json {
        stable_stringify(verdict, pretty)?.into()
    } else if verdict.passed {
        format!(
            "partial-twin ratchet: PASS — {} scope(s) on their ceiling.",
            number(verdict.scopes_checked)
        )
        .into()
    } else {
        let mut lines = ratchet_table_lines(verdict, &"PARTIAL-TWIN".into());
        if has_direction(verdict, CeilingDirection::Exceeded) {
            lines.extend([
                "  EXCEEDED: a new shared decision prologue diverges on the same named constants.".into(),
                "  Collapse it, or say in the PR body why the divergence is intended and re-record.".into(),
                "  `pnpm code-graph <scope> --collapse` shows the pairs.".into(),
            ]);
        }
        if has_direction(verdict, CeilingDirection::Slack) {
            lines.extend([
                "  SLACK: the ceiling sits above reality, so it is no longer a ceiling. Re-record:"
                    .into(),
                "  `pnpm code-graph <scope> --collapse --write-ceilings`.".into(),
            ]);
        }
        join(lines, "\n")
    };
    Ok(RatchetRender { stdout, exit_code })
}
