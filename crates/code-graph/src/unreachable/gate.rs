use super::ledger::{
    UNREACHABLE_LEDGER_FILENAME, UnreachableLedger, UnreachableLedgerRead,
    read_unreachable_ledger_unordered, unreachable_ledger_of,
};
use crate::{
    project::{Collation, CollationError, join_path_text},
    ratchet::scope_count::scope_of,
    schema::UnreachableCategory,
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
#[derive(Debug)]
pub enum UnreachablePreparationError {
    Scope(io::Error),
    Collation(CollationError),
}
impl std::fmt::Display for UnreachablePreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Scope(error) => error.fmt(f),
            Self::Collation(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for UnreachablePreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Scope(error) => error,
            Self::Collation(error) => error,
        })
    }
}

enum Admission {
    Complete(UnreachablePreparation),
    Order {
        mode: UnreachableMode,
        file: JsString,
        ledger: UnreachableLedger,
    },
}

fn admit(opts: UnreachableOpts<'_>, repo_root: &JsString) -> Admission {
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
        return Admission::Complete(UnreachablePreparation::Refused {
            message: message.into(),
            source: None,
        });
    }
    let mode = if !opts.unreachable {
        return Admission::Complete(UnreachablePreparation::None);
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
        return Admission::Complete(UnreachablePreparation::None);
    };
    let file = join_path_text(repo_root, &UNREACHABLE_LEDGER_FILENAME.into());
    let ledger = match read_unreachable_ledger_unordered(&file) {
        UnreachableLedgerRead::Absent => UnreachableLedger::default(),
        UnreachableLedgerRead::Read { ledger } => ledger,
        UnreachableLedgerRead::Invalid { message, source } => {
            let mut context = JsString::from("invalid unreachable ledger \"");
            context.extend(&file);
            context.push_str("\": ");
            context.extend(&message);
            context.push_str("; nothing was written.");
            return Admission::Complete(UnreachablePreparation::Refused {
                message: context,
                source,
            });
        }
    };
    Admission::Order { mode, file, ledger }
}

fn finish(
    admission: Admission,
    root_absolute: &JsString,
    repo_root: &JsString,
    collation: &Collation,
) -> Result<UnreachablePreparation, UnreachablePreparationError> {
    match admission {
        Admission::Complete(value) => Ok(value),
        Admission::Order { mode, file, ledger } => {
            let ledger = unreachable_ledger_of(&ledger.entries, collation)
                .map_err(UnreachablePreparationError::Collation)?;
            Ok(UnreachablePreparation::Prepared {
                gate: PreparedUnreachableGate {
                    mode,
                    file,
                    scope: scope_of(repo_root, root_absolute)
                        .map_err(UnreachablePreparationError::Scope)?,
                    ledger,
                },
            })
        }
    }
}

pub fn prepare_unreachable_gate(
    opts: UnreachableOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
    collation: &Collation,
) -> Result<UnreachablePreparation, UnreachablePreparationError> {
    finish(admit(opts, repo_root), root_absolute, repo_root, collation)
}

/// CLI-local dependency construction happens only after admission/read/schema refusals.
pub(crate) fn prepare_unreachable_gate_local(
    opts: UnreachableOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
    initialize: impl FnOnce() -> Result<Collation, CollationError>,
) -> Result<(UnreachablePreparation, Option<Collation>), UnreachablePreparationError> {
    let admission = admit(opts, repo_root);
    match admission {
        Admission::Complete(value) => Ok((value, None)),
        ready @ Admission::Order { .. } => {
            let collation = initialize().map_err(UnreachablePreparationError::Collation)?;
            let value = finish(ready, root_absolute, repo_root, &collation)?;
            Ok((value, Some(collation)))
        }
    }
}

pub struct UnreachableOutput<'a, E> {
    pub emit: &'a mut dyn FnMut(&JsString) -> Result<(), E>,
    pub report: &'a mut dyn FnMut(&JsString) -> Result<(), E>,
    pub json: bool,
    pub pretty: bool,
}
#[derive(Debug)]
pub enum UnreachableRunError<E> {
    Collation(CollationError),
    Write(super::ledger::UnreachableWriteError),
    Render(serde_json::Error),
    Emit(E),
    Report(E),
}
pub fn run_unreachable_gate<E>(
    gate: &PreparedUnreachableGate,
    graph: &crate::schema::Graph,
    out: UnreachableOutput<'_, E>,
    collation: &Collation,
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
    let findings = findings_of(&gate.scope, &reachability.unreachable, collation)
        .map_err(UnreachableRunError::Collation)?;
    match &gate.mode {
        UnreachableMode::Gate { gated } => {
            let result =
                reconcile_unreachable(&gate.ledger, &gate.scope, &findings, gated, collation)
                    .map_err(UnreachableRunError::Collation)?;
            if !result.pruned.is_empty() {
                write_unreachable_ledger(&gate.file, &result.kept, collation)
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
            let result =
                reconcile_unreachable(&gate.ledger, &gate.scope, &findings, &all, collation)
                    .map_err(UnreachableRunError::Collation)?;
            if !result.pruned.is_empty() || !result.unrecorded.is_empty() {
                write_unreachable_ledger(
                    &gate.file,
                    &with_accepted_findings(&result.kept, &result.unrecorded, reason, collation)
                        .map_err(UnreachableRunError::Collation)?,
                    collation,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rust_icu_common::Error as IcuError;
    use rust_icu_ucol::UCollator;
    use std::{cell::Cell, fs, rc::Rc};

    #[test]
    fn refusals_do_not_initialize_collation() {
        let directory =
            std::env::temp_dir().join(format!("demlik-icu-admission-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let root = JsString::from(directory.to_string_lossy().as_ref());
        let file = directory.join(UNREACHABLE_LEDGER_FILENAME);
        let calls = Rc::new(Cell::new(0));
        let initialize = || {
            calls.set(calls.get() + 1);
            Err(CollationError::Initialize(
                UCollator::try_from("en\0US").unwrap_err(),
            ))
        };
        let (inactive, owner) =
            prepare_unreachable_gate_local(UnreachableOpts::default(), &root, &root, initialize)
                .unwrap();
        assert!(matches!(inactive, UnreachablePreparation::None));
        assert!(owner.is_none());
        assert_eq!(calls.get(), 0);
        for text in ["{", "{}"] {
            fs::write(&file, text).unwrap();
            let (refusal, owner) = prepare_unreachable_gate_local(
                UnreachableOpts {
                    unreachable: true,
                    ci: true,
                    ..Default::default()
                },
                &root,
                &root,
                initialize,
            )
            .unwrap();
            assert!(matches!(refusal, UnreachablePreparation::Refused { .. }));
            assert!(owner.is_none());
            assert_eq!(calls.get(), 0);
            assert_eq!(fs::read_to_string(&file).unwrap(), text);
        }
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        let (refusal, _) = prepare_unreachable_gate_local(
            UnreachableOpts {
                unreachable: true,
                ci: true,
                ..Default::default()
            },
            &root,
            &root,
            initialize,
        )
        .unwrap();
        assert!(matches!(
            refusal,
            UnreachablePreparation::Refused {
                source: Some(_),
                ..
            }
        ));
        assert_eq!(calls.get(), 0);
        fs::remove_dir(&file).unwrap();
        fs::write(&file, "{\"entries\":[]}").unwrap();

        let cause = UCollator::try_from("en\0US").unwrap_err();
        let IcuError::Wrapper(inner) = &cause else {
            panic!("NUL locale must retain its wrapper cause")
        };
        let original =
            inner.downcast_ref::<std::ffi::NulError>().unwrap() as *const std::ffi::NulError;
        let actual = prepare_unreachable_gate_local(
            UnreachableOpts {
                unreachable: true,
                ci: true,
                ..Default::default()
            },
            &root,
            &root,
            || {
                calls.set(calls.get() + 1);
                Err(CollationError::Initialize(cause))
            },
        )
        .unwrap_err();
        let UnreachablePreparationError::Collation(CollationError::Initialize(IcuError::Wrapper(
            actual,
        ))) = actual
        else {
            panic!("native initialization cause must escape distinctly")
        };
        let actual = actual.downcast_ref::<std::ffi::NulError>().unwrap();
        assert!(std::ptr::eq(original, actual));
        assert_eq!(actual.nul_position(), 2);
        assert_eq!(calls.get(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"entries\":[]}");
        fs::remove_dir_all(directory).unwrap();
    }
}
