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
