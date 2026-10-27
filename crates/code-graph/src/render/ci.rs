use super::text::number;
use crate::{
    cli::io::CliIo,
    schema::{Graph, Severity},
    text::JsString,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailOn {
    High,
    Warn,
}
impl FailOn {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Warn => "warn",
        }
    }
    pub fn parse(value: &JsString) -> Option<Self> {
        if value == "high" {
            Some(Self::High)
        } else if value == "warn" {
            Some(Self::Warn)
        } else {
            None
        }
    }
}
pub struct CiResult {
    pub passed: bool,
    pub report: JsString,
}
pub fn evaluate_ci(graph: &Graph, fail_on: FailOn, max: Option<f64>) -> CiResult {
    let total = graph.smells.len();
    let high = graph
        .smells
        .iter()
        .filter(|smell| smell.severity == Severity::High)
        .count();
    let mut reasons = Vec::new();
    if fail_on == FailOn::High && high > 0 {
        reasons.push(format!(
            "{} high-severity smell{}",
            number(high as f64),
            if high == 1 { "" } else { "s" }
        ));
    }
    if fail_on == FailOn::Warn && total > 0 {
        reasons.push(format!(
            "{} smell{} (fail-on=warn)",
            number(total as f64),
            if total == 1 { "" } else { "s" }
        ));
    }
    if let Some(max) = max.filter(|max| total as f64 > *max) {
        reasons.push(format!(
            "{} {} --max {}",
            number(total as f64),
            if total == 1 {
                "smell exceeds"
            } else {
                "smells exceed"
            },
            number(max)
        ));
    }
    if !reasons.is_empty() {
        return CiResult {
            passed: false,
            report: format!("code-graph CI: FAIL — {}.", reasons.join("; ")).into(),
        };
    }
    let max_note = max
        .map(|max| format!(", max {}", number(max)))
        .unwrap_or_default();
    CiResult {
        passed: true,
        report: format!(
            "code-graph CI: PASS — {} smells, {} high-severity (fail-on={}{max_note}).",
            number(total as f64),
            number(high as f64),
            fail_on.as_str()
        )
        .into(),
    }
}
/// Ordinary CI writes directly to stdio; the CLI's OutputTo destination is not used.
pub fn run_smell_gate(
    graph: &Graph,
    fail_on: Option<&JsString>,
    max: Option<&JsString>,
    host: &mut CliIo<'_>,
) -> u8 {
    let policy = match fail_on {
        None => FailOn::High,
        Some(value) => match FailOn::parse(value) {
            Some(policy) => policy,
            None => {
                let mut line = JsString::from("warning: unknown --fail-on \"");
                line.extend(value);
                line.push_str("\"; falling back to \"high\".\n");
                host.write_stderr(&line);
                FailOn::High
            }
        },
    };
    let ceiling = if let Some(raw) = max {
        let trimmed = raw.trim_js();
        if trimmed.is_empty()
            || !trimmed
                .units()
                .iter()
                .all(|unit| (u16::from(b'0')..=u16::from(b'9')).contains(unit))
        {
            let mut line = JsString::from("error: --max expects a non-negative integer, got \"");
            line.extend(raw);
            line.push_str("\".\n");
            host.write_stderr(&line);
            return 2;
        }
        Some(trimmed.to_lossy().parse::<f64>().unwrap_or(f64::INFINITY))
    } else {
        None
    };
    let result = evaluate_ci(graph, policy, ceiling);
    let mut report = result.report;
    report.push_str("\n");
    host.write_stdout(&report);
    if result.passed { 0 } else { 1 }
}
