use super::ledger::{
    UNREACHABLE_LEDGER_FILENAME, UnreachableLedger, UnreachableLedgerRead, read_unreachable_ledger,
};
use crate::{
    project::join_path_text, ratchet::scope_count::scope_of, schema::UnreachableCategory,
    text::JsString,
};
use serde::Serialize;
use std::io;

#[derive(Debug, Default)]
pub struct UnreachableOpts<'a> {
    pub unreachable: bool,
    pub ci: bool,
    pub accept_dead: bool,
    pub dead_only: bool,
    pub boundaries: bool,
    pub reason: Option<&'a JsString>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UnreachableMode {
    Gate { gated: Vec<UnreachableCategory> },
    Accept { reason: JsString },
}
#[derive(Debug, Serialize)]
pub struct PreparedUnreachableGate {
    pub mode: UnreachableMode,
    pub file: JsString,
    pub scope: JsString,
    pub ledger: UnreachableLedger,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum UnreachablePreparation {
    None,
    Refused {
        message: JsString,
        #[serde(skip)]
        source: Option<io::Error>,
    },
    Prepared {
        gate: PreparedUnreachableGate,
    },
}
pub fn prepare_unreachable_gate(
    opts: UnreachableOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
) -> Result<UnreachablePreparation, io::Error> {
    let reason = opts.reason.map(JsString::trim_js);
    let checks = [
        (
            opts.accept_dead && !opts.unreachable,
            "--accept-dead only rides --unreachable; nothing was written.",
        ),
        (
            opts.dead_only && !(opts.unreachable && opts.ci),
            "--dead-only only rides --unreachable --ci; nothing was written.",
        ),
        (
            opts.accept_dead && opts.ci,
            "pass one of --ci, --accept-dead with --unreachable; nothing was written.",
        ),
        (
            opts.accept_dead && reason.as_ref().is_none_or(JsString::is_empty),
            "`--accept-dead` needs a non-empty `--reason \"<why>\"`; nothing was written.",
        ),
        (
            opts.unreachable && reason.is_some() && !opts.accept_dead && !opts.boundaries,
            "--reason only rides `--unreachable --accept-dead` or `--boundaries --accept-crossings`.",
        ),
    ];
    if let Some((_, message)) = checks.into_iter().find(|(refuses, _)| *refuses) {
        return Ok(UnreachablePreparation::Refused {
            message: message.into(),
            source: None,
        });
    }
    let mode = if !opts.unreachable {
        return Ok(UnreachablePreparation::None);
    } else if opts.accept_dead {
        UnreachableMode::Accept {
            reason: reason.unwrap_or_default(),
        }
    } else if opts.ci {
        UnreachableMode::Gate {
            gated: if opts.dead_only {
                vec![UnreachableCategory::Dead]
            } else {
                vec![
                    UnreachableCategory::Dead,
                    UnreachableCategory::OnlyCalledFromTests,
                ]
            },
        }
    } else {
        return Ok(UnreachablePreparation::None);
    };
    let file = join_path_text(repo_root, &UNREACHABLE_LEDGER_FILENAME.into());
    let ledger = match read_unreachable_ledger(&file) {
        UnreachableLedgerRead::Absent => UnreachableLedger::default(),
        UnreachableLedgerRead::Read { ledger } => ledger,
        UnreachableLedgerRead::Invalid { message, source } => {
            let mut context = JsString::from("invalid unreachable ledger \"");
            context.extend(&file);
            context.push_str("\": ");
            context.extend(&message);
            context.push_str("; nothing was written.");
            return Ok(UnreachablePreparation::Refused {
                message: context,
                source,
            });
        }
    };
    Ok(UnreachablePreparation::Prepared {
        gate: PreparedUnreachableGate {
            mode,
            file,
            scope: scope_of(repo_root, root_absolute)?,
            ledger,
        },
    })
}

pub struct UnreachableOutput<'a, E> {
    pub emit: &'a mut dyn FnMut(&JsString) -> Result<(), E>,
    pub report: &'a mut dyn FnMut(&JsString) -> Result<(), E>,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug)]
pub enum UnreachableRunError<E> {
    Write(super::ledger::UnreachableWriteError),
    Render(serde_json::Error),
    Emit(E),
    Report(E),
}
pub fn run_unreachable_gate<E>(
    gate: &PreparedUnreachableGate,
    graph: &crate::schema::Graph,
    out: UnreachableOutput<'_, E>,
) -> Result<i32, UnreachableRunError<E>> {
    use super::{
        ledger::{
            findings_of, reconcile_unreachable, with_accepted_findings, write_unreachable_ledger,
        },
        render::{render_accepted_dead, render_unreachable_gate},
    };
    let Some(reachability) = &graph.reachability else {
        (out.report)(&JsString::from(
            "the reachability pass did not run; the unreachable gate has nothing to read.",
        ))
        .map_err(UnreachableRunError::Report)?;
        return Ok(2);
    };
    let findings = findings_of(&gate.scope, &reachability.unreachable);
    match &gate.mode {
        UnreachableMode::Gate { gated } => {
            let result = reconcile_unreachable(&gate.ledger, &gate.scope, &findings, gated);
            if !result.pruned.is_empty() {
                write_unreachable_ledger(&gate.file, &result.kept)
                    .map_err(UnreachableRunError::Write)?;
            }
            let rendered = render_unreachable_gate(&result, out.json, out.pretty)
                .map_err(UnreachableRunError::Render)?;
            let mut payload = rendered.stdout;
            payload.push_str("\n");
            (out.emit)(&payload).map_err(UnreachableRunError::Emit)?;
            Ok(rendered.exit_code)
        }
        UnreachableMode::Accept { reason } => {
            let all = [
                UnreachableCategory::Dead,
                UnreachableCategory::OnlyCalledFromTests,
            ];
            let result = reconcile_unreachable(&gate.ledger, &gate.scope, &findings, &all);
            if !result.pruned.is_empty() || !result.unrecorded.is_empty() {
                write_unreachable_ledger(
                    &gate.file,
                    &with_accepted_findings(&result.kept, &result.unrecorded, reason),
                )
                .map_err(UnreachableRunError::Write)?;
            }
            let mut payload = render_accepted_dead(&result, reason, out.json, out.pretty)
                .map_err(UnreachableRunError::Render)?;
            payload.push_str("\n");
            (out.emit)(&payload).map_err(UnreachableRunError::Emit)?;
            Ok(0)
        }
    }
}
