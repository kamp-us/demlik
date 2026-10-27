use super::ledger::{
    RuleNameConversionError, SMELL_LEDGER_FILENAME, SmellLedger, SmellLedgerRead, needs_edges,
    read_smell_ledger,
};
use crate::{project::join_path_text, ratchet::scope_count::scope_of, text::JsString};
use serde::Serialize;
use std::io;

#[derive(Debug, Default)]
pub struct SmellGateOpts<'a> {
    pub ci: bool,
    pub accept_smells: bool,
    pub unreachable: bool,
    pub boundaries: bool,
    pub comments: bool,
    pub collapse: bool,
    pub layers: bool,
    pub reason: Option<&'a JsString>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SmellGateMode {
    Gate,
    Accept { reason: JsString },
}
#[derive(Debug, Serialize)]
pub struct PreparedSmellGate {
    pub mode: SmellGateMode,
    pub file: JsString,
    pub scope: JsString,
    pub ledger: SmellLedger,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SmellPreparation {
    None,
    Refused {
        message: JsString,
        #[serde(skip)]
        source: Option<io::Error>,
    },
    Prepared {
        gate: PreparedSmellGate,
    },
}
#[derive(Debug)]
pub enum SmellPreparationError {
    RuleName(RuleNameConversionError),
    Scope(io::Error),
}
impl SmellPreparationError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::RuleName(error) => error.name(),
            Self::Scope(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::RuleName(error) => error.message(),
            Self::Scope(error) => error.to_string().into(),
        }
    }
}
impl std::fmt::Display for SmellPreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().to_lossy())
    }
}
impl std::error::Error for SmellPreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::RuleName(error) => error,
            Self::Scope(error) => error,
        })
    }
}
pub fn prepare_smell_gate(
    opts: SmellGateOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
) -> Result<SmellPreparation, SmellPreparationError> {
    let reason = opts.reason.map(JsString::trim_js);
    let other_gate =
        opts.unreachable || opts.boundaries || opts.comments || opts.collapse || opts.layers;
    let checks = [
        (
            opts.accept_smells && other_gate,
            "--accept-smells runs on its own, not with --unreachable, --boundaries, --comments, --collapse or --layers; nothing was written.",
        ),
        (
            opts.accept_smells && opts.ci,
            "pass one of --ci, --accept-smells; nothing was written.",
        ),
        (
            opts.accept_smells && reason.as_ref().is_none_or(JsString::is_empty),
            "`--accept-smells` needs a non-empty `--reason \"<why>\"`; nothing was written.",
        ),
    ];
    if let Some((_, message)) = checks.into_iter().find(|(refuses, _)| *refuses) {
        return Ok(SmellPreparation::Refused {
            message: message.into(),
            source: None,
        });
    }
    let mode = if opts.accept_smells {
        SmellGateMode::Accept {
            reason: reason.unwrap_or_default(),
        }
    } else if opts.ci && !other_gate {
        SmellGateMode::Gate
    } else {
        return Ok(SmellPreparation::None);
    };
    let file = join_path_text(repo_root, &SMELL_LEDGER_FILENAME.into());
    let ledger = match read_smell_ledger(&file).map_err(SmellPreparationError::RuleName)? {
        SmellLedgerRead::Invalid { message, source } => {
            let mut context = JsString::from("invalid smell ledger \"");
            context.extend(&file);
            context.push_str("\": ");
            context.extend(&message);
            context.push_str("; nothing was written.");
            return Ok(SmellPreparation::Refused {
                message: context,
                source,
            });
        }
        SmellLedgerRead::Read { ledger } if !ledger.gated.is_empty() => ledger,
        _ => {
            if matches!(mode, SmellGateMode::Gate) {
                return Ok(SmellPreparation::None);
            }
            let mut message = JsString::from(
                "--accept-smells: no smell rule is gated; name the rules in the \"gated\" list of \"",
            );
            message.extend(&file);
            message.push_str("\" first; nothing was written.");
            return Ok(SmellPreparation::Refused {
                message,
                source: None,
            });
        }
    };
    Ok(SmellPreparation::Prepared {
        gate: PreparedSmellGate {
            mode,
            file,
            scope: scope_of(repo_root, root_absolute).map_err(SmellPreparationError::Scope)?,
            ledger,
        },
    })
}
pub fn smell_gate_needs_edges(preparation: &SmellPreparation) -> bool {
    matches!(preparation,SmellPreparation::Prepared{gate}if needs_edges(&gate.ledger.gated))
}

/// Runs persistence and prepares one emission, including its final LF.
/// Call the existing output owner next, and assign exit only if that call succeeds.
pub fn run_smell_ledger_gate(
    gate: &PreparedSmellGate,
    graph: &crate::schema::Graph,
    json: bool,
    pretty: bool,
) -> Result<super::ledger_render::SmellLedgerRender, super::ledger::SmellLedgerError> {
    use super::{
        ledger::{
            SmellLedgerError, findings_of, measured_rules, reconcile_smells, with_accepted_smells,
            write_smell_ledger,
        },
        ledger_render::{SmellLedgerRender, render_accepted_smells, render_smell_ledger_gate},
    };
    let findings = findings_of(&gate.scope, &graph.smells);
    let result = reconcile_smells(&gate.ledger, &gate.scope, &findings, &measured_rules(graph));
    let mut rendered = match &gate.mode {
        SmellGateMode::Gate => {
            if !result.pruned.is_empty() || !result.lowered.is_empty() {
                write_smell_ledger(&gate.file, &result.kept)?;
            }
            render_smell_ledger_gate(&result, json, pretty).map_err(SmellLedgerError::Json)?
        }
        SmellGateMode::Accept { reason } => {
            let changed = result.pruned.len()
                + result.lowered.len()
                + result.unrecorded.len()
                + result.worsened.len();
            if changed > 0 {
                write_smell_ledger(&gate.file, &with_accepted_smells(&result, reason))?;
            }
            SmellLedgerRender {
                stdout: render_accepted_smells(&result, reason, json, pretty)
                    .map_err(SmellLedgerError::Json)?,
                exit_code: 0,
            }
        }
    };
    rendered.stdout.push_str("\n");
    Ok(rendered)
}
