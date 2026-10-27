use super::ledger::{
    RuleNameConversionError, SMELL_LEDGER_FILENAME, SmellLedger, SmellLedgerRead, needs_edges,
    read_smell_ledger_unordered, smell_ledger_of,
};
use crate::{
    project::{Collation, CollationError, join_path_text},
    ratchet::scope_count::scope_of,
    text::JsString,
};
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
    Collation(CollationError),
    RuleName(RuleNameConversionError),
    Scope(io::Error),
}
impl SmellPreparationError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::RuleName(error) => error.name(),
            Self::Collation(_) | Self::Scope(_) => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::RuleName(error) => error.message(),
            Self::Collation(error) => error.to_string().into(),
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
            Self::Collation(error) => error,
            Self::Scope(error) => error,
        })
    }
}
enum Admission {
    Complete(SmellPreparation),
    Order {
        mode: SmellGateMode,
        file: JsString,
        ledger: SmellLedger,
    },
}

fn admit(
    opts: SmellGateOpts<'_>,
    repo_root: &JsString,
) -> Result<Admission, SmellPreparationError> {
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
        return Ok(Admission::Complete(SmellPreparation::Refused {
            message: message.into(),
            source: None,
        }));
    }
    let mode = if opts.accept_smells {
        SmellGateMode::Accept {
            reason: reason.unwrap_or_default(),
        }
    } else if opts.ci && !other_gate {
        SmellGateMode::Gate
    } else {
        return Ok(Admission::Complete(SmellPreparation::None));
    };
    let file = join_path_text(repo_root, &SMELL_LEDGER_FILENAME.into());
    let ledger = match read_smell_ledger_unordered(&file)
        .map_err(SmellPreparationError::RuleName)?
    {
        SmellLedgerRead::Invalid { message, source } => {
            let mut context = JsString::from("invalid smell ledger \"");
            context.extend(&file);
            context.push_str("\": ");
            context.extend(&message);
            context.push_str("; nothing was written.");
            return Ok(Admission::Complete(SmellPreparation::Refused {
                message: context,
                source,
            }));
        }
        SmellLedgerRead::Read { ledger } if !ledger.gated.is_empty() => ledger,
        _ => {
            if matches!(mode, SmellGateMode::Gate) {
                return Ok(Admission::Complete(SmellPreparation::None));
            }
            let mut message = JsString::from(
                "--accept-smells: no smell rule is gated; name the rules in the \"gated\" list of \"",
            );
            message.extend(&file);
            message.push_str("\" first; nothing was written.");
            return Ok(Admission::Complete(SmellPreparation::Refused {
                message,
                source: None,
            }));
        }
    };
    Ok(Admission::Order { mode, file, ledger })
}
fn finish(
    admission: Admission,
    root_absolute: &JsString,
    repo_root: &JsString,
    collation: &Collation,
) -> Result<SmellPreparation, SmellPreparationError> {
    match admission {
        Admission::Complete(value) => Ok(value),
        Admission::Order { mode, file, ledger } => {
            let ledger = smell_ledger_of(&ledger.gated, &ledger.entries, collation)
                .map_err(SmellPreparationError::Collation)?;
            Ok(SmellPreparation::Prepared {
                gate: PreparedSmellGate {
                    mode,
                    file,
                    scope: scope_of(repo_root, root_absolute)
                        .map_err(SmellPreparationError::Scope)?,
                    ledger,
                },
            })
        }
    }
}
pub fn prepare_smell_gate(
    opts: SmellGateOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
    collation: &Collation,
) -> Result<SmellPreparation, SmellPreparationError> {
    finish(admit(opts, repo_root)?, root_absolute, repo_root, collation)
}

/// Build the CLI-local dependency only after flags/read/schema/no-rule admission.
pub(crate) fn prepare_smell_gate_local(
    opts: SmellGateOpts<'_>,
    root_absolute: &JsString,
    repo_root: &JsString,
    initialize: impl FnOnce() -> Result<Collation, CollationError>,
) -> Result<(SmellPreparation, Option<Collation>), SmellPreparationError> {
    let admission = admit(opts, repo_root)?;
    match admission {
        Admission::Complete(value) => Ok((value, None)),
        ready @ Admission::Order { .. } => {
            let collation = initialize().map_err(SmellPreparationError::Collation)?;
            let value = finish(ready, root_absolute, repo_root, &collation)?;
            Ok((value, Some(collation)))
        }
    }
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
    collation: &Collation,
) -> Result<super::ledger_render::SmellLedgerRender, super::ledger::SmellLedgerError> {
    use super::{
        ledger::{
            SmellLedgerError, findings_of, measured_rules, reconcile_smells, with_accepted_smells,
            write_smell_ledger,
        },
        ledger_render::{SmellLedgerRender, render_accepted_smells, render_smell_ledger_gate},
    };
    let findings =
        findings_of(&gate.scope, &graph.smells, collation).map_err(SmellLedgerError::Collation)?;
    let result = reconcile_smells(
        &gate.ledger,
        &gate.scope,
        &findings,
        &measured_rules(graph),
        collation,
    )
    .map_err(SmellLedgerError::Collation)?;
    let mut rendered = match &gate.mode {
        SmellGateMode::Gate => {
            if !result.pruned.is_empty() || !result.lowered.is_empty() {
                write_smell_ledger(&gate.file, &result.kept, collation)?;
            }
            render_smell_ledger_gate(&result, json, pretty).map_err(SmellLedgerError::Json)?
        }
        SmellGateMode::Accept { reason } => {
            let changed = result.pruned.len()
                + result.lowered.len()
                + result.unrecorded.len()
                + result.worsened.len();
            if changed > 0 {
                let accepted = with_accepted_smells(&result, reason, collation)
                    .map_err(SmellLedgerError::Collation)?;
                write_smell_ledger(&gate.file, &accepted, collation)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use rust_icu_common::Error as IcuError;
    use rust_icu_ucol::UCollator;
    use std::{cell::Cell, fs, rc::Rc};

    #[test]
    fn refusals_do_not_initialize_collation() {
        let directory =
            std::env::temp_dir().join(format!("demlik-smell-admission-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let root = JsString::from(directory.to_string_lossy().as_ref());
        let file = directory.join(SMELL_LEDGER_FILENAME);
        let calls = Rc::new(Cell::new(0));
        let initialize = || {
            calls.set(calls.get() + 1);
            Err(CollationError::Initialize(
                UCollator::try_from("en\0US").unwrap_err(),
            ))
        };
        let (inactive, owner) =
            prepare_smell_gate_local(SmellGateOpts::default(), &root, &root, initialize).unwrap();
        assert!(matches!(inactive, SmellPreparation::None));
        assert!(owner.is_none());
        assert_eq!(calls.get(), 0);
        let reason = JsString::from("retained");
        let (conflict, _) = prepare_smell_gate_local(
            SmellGateOpts {
                accept_smells: true,
                layers: true,
                reason: Some(&reason),
                ..Default::default()
            },
            &root,
            &JsString::from_units(vec![0]),
            initialize,
        )
        .unwrap();
        assert!(matches!(conflict, SmellPreparation::Refused { .. }));
        let (absent, _) = prepare_smell_gate_local(
            SmellGateOpts {
                ci: true,
                ..Default::default()
            },
            &root,
            &root,
            initialize,
        )
        .unwrap();
        assert!(matches!(absent, SmellPreparation::None));
        for text in ["{", r#"{"gated":["unknown"]}"#] {
            fs::write(&file, text).unwrap();
            let (refusal, owner) = prepare_smell_gate_local(
                SmellGateOpts {
                    ci: true,
                    ..Default::default()
                },
                &root,
                &root,
                initialize,
            )
            .unwrap();
            assert!(matches!(refusal, SmellPreparation::Refused { .. }));
            assert!(owner.is_none());
            assert_eq!(calls.get(), 0);
            assert_eq!(fs::read_to_string(&file).unwrap(), text);
        }
        fs::write(&file, r#"{"gated":["unknown",{"toString":null}]}"#).unwrap();
        let error = prepare_smell_gate_local(
            SmellGateOpts {
                ci: true,
                ..Default::default()
            },
            &root,
            &root,
            initialize,
        )
        .unwrap_err();
        let SmellPreparationError::RuleName(error) = error else {
            panic!("the original rule conversion error must escape")
        };
        assert_eq!(
            error.path,
            [
                crate::validation::PathSegment::Field("gated".into()),
                crate::validation::PathSegment::Index(1)
            ]
        );
        for text in [
            "{}",
            r#"{"gated":[],"entries":[{"rule":"big-file","target":"\ud800","value":2,"reason":"kept"}]}"#,
        ] {
            fs::write(&file, text).unwrap();
            let (empty, owner) = prepare_smell_gate_local(
                SmellGateOpts {
                    ci: true,
                    ..Default::default()
                },
                &root,
                &root,
                initialize,
            )
            .unwrap();
            assert!(matches!(empty, SmellPreparation::None));
            assert!(owner.is_none());
            assert_eq!(calls.get(), 0);
        }
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        let (refusal, _) = prepare_smell_gate_local(
            SmellGateOpts {
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
            SmellPreparation::Refused {
                source: Some(_),
                ..
            }
        ));
        assert_eq!(calls.get(), 0);
        fs::remove_dir(&file).unwrap();
        fs::write(&file, r#"{"gated":["big-file"]}"#).unwrap();
        let cause = UCollator::try_from("en\0US").unwrap_err();
        let IcuError::Wrapper(inner) = &cause else {
            panic!("expected owned NUL cause")
        };
        let original =
            inner.downcast_ref::<std::ffi::NulError>().unwrap() as *const std::ffi::NulError;
        let actual = prepare_smell_gate_local(
            SmellGateOpts {
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
        let SmellPreparationError::Collation(CollationError::Initialize(IcuError::Wrapper(actual))) =
            actual
        else {
            panic!("typed infrastructure error must escape")
        };
        let actual = actual.downcast_ref::<std::ffi::NulError>().unwrap();
        assert!(std::ptr::eq(original, actual));
        assert_eq!(actual.nul_position(), 2);
        assert_eq!(calls.get(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
