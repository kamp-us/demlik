use super::{
    deployables::census::{DeployableCensus, deployable_census_lines},
    ledger::{
        BoundaryKind, BoundaryLedger, BoundaryLedgerEntry, LEDGER_FILENAME, ledger_key,
        ledger_target_of,
    },
    libraries::census::{LibraryCensus, census_lines},
    migrate::{CeilingBreach, LEGACY_CEILINGS_FILENAME},
    reconcile::Reconciliation,
    rules::interpolate,
    violation::{BoundaryViolation, Crossing, ScopeBoundaryReport, WriteSite, crossing_of},
};
use crate::{
    render::{
        json::stable_stringify,
        text::{join, number, pad_end},
    },
    text::JsString,
};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryRender {
    pub stdout: JsString,
    pub exit_code: u8,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Censuses<'a> {
    pub libraries: Option<&'a LibraryCensus>,
    pub deployables: Option<&'a DeployableCensus>,
}
// Variant order is the source renderer's advice block order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Advice {
    Feature,
    Hexagonal,
    Impure,
    Library,
    Deployable,
    Shape,
    Test,
}
struct KindInfo {
    rule: &'static str,
    advice: Advice,
}
fn kind_info(kind: BoundaryKind) -> KindInfo {
    use BoundaryKind::*;
    let (rule, advice) = match kind {
        CrossFeature => ("B1", Advice::Feature),
        LibImportsFeature => ("B3", Advice::Feature),
        OutsideImportsFeatureInternal => ("B4", Advice::Feature),
        ApplicationImportsAdapter => ("B6", Advice::Hexagonal),
        Impure => ("B7", Advice::Impure),
        DrivingReachesDriven => ("B8", Advice::Hexagonal),
        UnknownZone => ("B10", Advice::Hexagonal),
        LibraryUndeclared => ("B11", Advice::Library),
        LibraryImportsUp => ("B12", Advice::Library),
        AdapterLibraryImportedOutsideDriven => ("B14", Advice::Library),
        IndexNotExportsOnly => ("B15", Advice::Shape),
        ApplicationImportOutsideAllowlist => ("B16", Advice::Shape),
        BindingOutsideDrivenAdapter => ("B17", Advice::Deployable),
        WorkerCallCycle => ("B18", Advice::Deployable),
        RelativeImportCrossesWorkspace => ("B19", Advice::Deployable),
        TestReachesCompositionRoot => ("B20", Advice::Test),
    };
    KindInfo { rule, advice }
}
fn written_as(entry: &BoundaryLedgerEntry) -> JsString {
    if crossing_of(entry.kind) == Crossing::Import {
        interpolate(&["  (\"".into(), entry.specifier.clone(), "\")".into()])
    } else {
        JsString::default()
    }
}
fn write_note(write: Option<&WriteSite>) -> JsString {
    write.map_or_else(JsString::default, |write| {
        interpolate(&[
            "  [write: ".into(),
            write.binding.clone(),
            " at ".into(),
            write.file.clone(),
            ":".into(),
            number(write.line).into(),
            "]".into(),
        ])
    })
}
fn violation_line(violation: &BoundaryViolation) -> JsString {
    let entry = violation.ledger_entry(JsString::default());
    interpolate(&[
        format!(
            "  {} {} ",
            kind_info(entry.kind).rule,
            pad_end(entry.kind.as_str(), 19)
        )
        .into(),
        entry.from.clone(),
        " -> ".into(),
        ledger_target_of(&entry).clone(),
        written_as(&entry),
        if violation.type_only() {
            "  [type-only]".into()
        } else {
            JsString::default()
        },
        write_note(violation.write().map(std::sync::Arc::as_ref)),
    ])
}
fn scope_header(report: &ScopeBoundaryReport) -> JsString {
    if report.features.is_empty() {
        interpolate(&[report.scope.clone(), " — library scope".into()])
    } else {
        interpolate(&[
            report.scope.clone(),
            " — features: ".into(),
            join(report.features.iter().cloned(), ", "),
        ])
    }
}
fn scope_lines(report: &ScopeBoundaryReport) -> Vec<JsString> {
    let mut lines = match &report.workers {
        None => vec![
            scope_header(report),
            format!(
                "  scanned {} files — {} violation(s)",
                number(report.files_scanned),
                number(report.violations.len() as f64)
            )
            .into(),
        ],
        Some(workers) => vec![
            interpolate(&[report.scope.clone(), " — worker call graph".into()]),
            format!(
                "  {} worker(s) — {} violation(s)",
                number(workers.len() as f64),
                number(report.violations.len() as f64)
            )
            .into(),
        ],
    };
    lines.extend(report.violations.iter().map(violation_line));
    lines
}
pub fn render_boundaries(
    reports: &[ScopeBoundaryReport],
    under: &JsString,
    censuses: Censuses<'_>,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        #[derive(Serialize)]
        struct Snapshot<'a> {
            scopes: &'a [ScopeBoundaryReport],
            #[serde(skip_serializing_if = "Option::is_none")]
            libraries: Option<&'a LibraryCensus>,
            #[serde(skip_serializing_if = "Option::is_none")]
            deployables: Option<&'a DeployableCensus>,
        }
        return stable_stringify(
            &Snapshot {
                scopes: reports,
                libraries: censuses.libraries,
                deployables: censuses.deployables,
            },
            pretty,
        )
        .map(JsString::from);
    }
    if reports.is_empty() {
        let declared = if censuses.libraries.is_none() {
            "feature scope"
        } else {
            "feature or library scope"
        };
        return Ok(interpolate(&[
            format!("boundaries: no {declared} declared at or under \"").into(),
            under.clone(),
            "\" — nothing to check.".into(),
        ]));
    }
    let mut lines: Vec<_> = reports.iter().flat_map(scope_lines).collect();
    if let Some(census) = censuses.libraries {
        lines.extend(census_lines(census));
    }
    if let Some(census) = censuses.deployables {
        lines.extend(deployable_census_lines(census));
    }
    Ok(join(lines, "\n"))
}

const FIX_LINES: &[&str] = &[
    "  Import a feature from outside it through its index.ts, and keep lib/ out of features. A",
    "  crossing that has to stay is added by name and with a reason:",
    "  `code-graph <scope> --boundaries --accept-crossings --reason \"<why>\"`.",
];
impl Advice {
    fn lines(self) -> &'static [&'static str] {
        match self {
            Self::Feature => &[],
            Self::Hexagonal => &[
                "  In a hexagonal feature, keep application/ off its own adapters/, let adapters/driving/ reach",
                "  the core only through ports.ts and index.ts, and keep the feature to index.ts, ports.ts,",
                "  application/, adapters/driving/ and adapters/driven/. A scope whose features are application,",
                "  driving-adapters and driven-adapters is one hexagon in the port layout, zones straight under",
                "  src/: application/ (its application/driving-ports/ and application/driven-ports/ are the",
                "  ports), driving-adapters/ and driven-adapters/, under the same rules.",
            ],
            Self::Impure => &[
                "  Reach the outside world (any process.<member>, fetch, the clock, node:fs) only in",
                "  adapters/driven/ (driven-adapters/ in the port layout), and keep a pure library free of it and",
                "  of `worldLibraries`.",
            ],
            Self::Library => &[
                "  Declare every package under a library root in `libraries`, import only the library types a",
                "  type's `imports` lists, and import a library that names `importedFrom` only from those zones. A",
                "  library that may take only some names of another is licensed in `allowImportNames`, per importer",
                "  and imported library.",
            ],
            Self::Deployable => &[
                "  Use a worker binding only in a feature's adapters/driven/ (driven-adapters/ in the port layout)",
                "  or in its worker's wrangler main (`bindingOwners` narrows one to exact driven files), break a",
                "  loop of workers that bind each other, and reach another workspace by its package name, never a",
                "  relative path.",
            ],
            Self::Shape => &[
                "  Keep an entry file (a library's src/index.ts, a feature's index.ts) to named re-exports, and an",
                "  application/ file to its own ports (ports.ts, or the port folders of the port layout) and",
                "  application/, another feature's index.ts, lib, a library whose type `applicationMayImport`",
                "  lists and a `pureDependencies` package.",
            ],
            Self::Test => &[
                "  A test drives the one feature under test and wires its own fakes: it imports that feature's",
                "  index.ts, never a composition root (a worker entry, the module that assembles every feature) or",
                "  a helper that opens one. A deliberate test of the wiring is accepted by name and with a reason.",
            ],
        }
    }
}
fn entry_line(entry: &BoundaryLedgerEntry, write: Option<&WriteSite>) -> JsString {
    let reason = entry
        .reason
        .as_ref()
        .map_or_else(JsString::default, |reason| {
            interpolate(&["  — ".into(), reason.clone()])
        });
    interpolate(&[
        "  ".into(),
        entry.scope.clone(),
        format!("  {} {}  ", kind_info(entry.kind).rule, entry.kind.as_str()).into(),
        entry.from.clone(),
        " -> ".into(),
        ledger_target_of(entry).clone(),
        written_as(entry),
        write_note(write),
        reason,
    ])
}
fn unrecorded_lines(result: &Reconciliation) -> impl Iterator<Item = JsString> + '_ {
    result.unrecorded.iter().map(|entry| {
        entry_line(
            entry,
            result
                .writes
                .get(&ledger_key(entry))
                .map(std::sync::Arc::as_ref),
        )
    })
}
fn pruned_lines(pruned: &[std::sync::Arc<BoundaryLedgerEntry>]) -> Vec<JsString> {
    if pruned.is_empty() {
        return vec![];
    }
    let mut lines = vec![
        format!(
            "pruned {} {LEDGER_FILENAME} entr{} whose crossing is gone:",
            number(pruned.len() as f64),
            if pruned.len() == 1 { "y" } else { "ies" }
        )
        .into(),
    ];
    lines.extend(pruned.iter().map(|entry| entry_line(entry, None)));
    lines
}
fn fix_lines(unrecorded: &[std::sync::Arc<BoundaryLedgerEntry>]) -> Vec<JsString> {
    let needed: BTreeSet<_> = unrecorded
        .iter()
        .map(|entry| kind_info(entry.kind).advice)
        .collect();
    FIX_LINES
        .iter()
        .copied()
        .chain(needed.into_iter().flat_map(Advice::lines).copied())
        .map(JsString::from)
        .collect()
}
pub fn render_ledger_gate(
    result: &Reconciliation,
    json: bool,
    pretty: bool,
) -> Result<BoundaryRender, serde_json::Error> {
    let passed = result.unrecorded.is_empty();
    let exit_code = u8::from(!passed);
    if json {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Snapshot<'a> {
            passed: bool,
            #[serde(serialize_with = "crate::text::serialize_number")]
            scopes_checked: f64,
            unrecorded: &'a [std::sync::Arc<BoundaryLedgerEntry>],
            pruned: &'a [std::sync::Arc<BoundaryLedgerEntry>],
        }
        return Ok(BoundaryRender {
            stdout: stable_stringify(
                &Snapshot {
                    passed,
                    scopes_checked: result.scopes_checked,
                    unrecorded: &result.unrecorded,
                    pruned: &result.pruned,
                },
                pretty,
            )?
            .into(),
            exit_code,
        });
    }
    let mut lines = if passed {
        vec![
            format!(
                "boundary ledger: PASS — {} scope(s), {} recorded crossing(s), none new.",
                number(result.scopes_checked),
                number(result.kept.entries.len() as f64)
            )
            .into(),
        ]
    } else {
        let mut lines = vec![
            format!(
                "BOUNDARY LEDGER FAILED — {} crossing(s) not in {LEDGER_FILENAME}:",
                number(result.unrecorded.len() as f64)
            )
            .into(),
        ];
        lines.extend(unrecorded_lines(result));
        lines.extend(fix_lines(&result.unrecorded));
        lines
    };
    lines.extend(pruned_lines(&result.pruned));
    Ok(BoundaryRender {
        stdout: join(lines, "\n"),
        exit_code,
    })
}
pub fn render_accepted(
    result: &Reconciliation,
    reason: &JsString,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        #[derive(Serialize)]
        struct Snapshot<'a> {
            accepted: &'a [std::sync::Arc<BoundaryLedgerEntry>],
            pruned: &'a [std::sync::Arc<BoundaryLedgerEntry>],
            reason: &'a JsString,
        }
        return stable_stringify(
            &Snapshot {
                accepted: &result.unrecorded,
                pruned: &result.pruned,
                reason,
            },
            pretty,
        )
        .map(JsString::from);
    }
    let mut lines = if result.unrecorded.is_empty() {
        vec!["accept-crossings: no unrecorded crossing — nothing to add.".into()]
    } else {
        let mut lines = vec![interpolate(&[
            format!(
                "accepted {} crossing(s) into {LEDGER_FILENAME}, reason \"",
                number(result.unrecorded.len() as f64)
            )
            .into(),
            reason.clone(),
            "\":".into(),
        ])];
        lines.extend(unrecorded_lines(result));
        lines
    };
    lines.extend(pruned_lines(&result.pruned));
    Ok(join(lines, "\n"))
}
pub fn render_migrated(
    ledger: &BoundaryLedger,
    scopes: f64,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if json {
        #[derive(Serialize)]
        struct Snapshot {
            migrated: usize,
            #[serde(serialize_with = "crate::text::serialize_number")]
            scopes: f64,
        }
        return stable_stringify(
            &Snapshot {
                migrated: ledger.entries.len(),
                scopes,
            },
            pretty,
        )
        .map(JsString::from);
    }
    Ok(format!("migrated {} scope(s): seeded {LEDGER_FILENAME} with {} crossing(s) and removed {LEGACY_CEILINGS_FILENAME}.", number(scopes), number(ledger.entries.len() as f64)).into())
}
pub fn render_migration_refused(breaches: &[CeilingBreach]) -> JsString {
    let mut lines = vec![format!("--migrate-ceilings refused, nothing written: {} scope(s) cross more than {LEGACY_CEILINGS_FILENAME} allows, and seeding the ledger from them would loosen it.", number(breaches.len() as f64)).into()];
    lines.extend(breaches.iter().map(|breach| {
        interpolate(&[
            "  ".into(),
            breach.scope.clone(),
            format!(
                ": {} crossing(s) against a recorded ceiling of {}",
                number(breach.measured),
                number(breach.ceiling)
            )
            .into(),
        ])
    }));
    lines.push("  Remove the new crossings, then migrate.".into());
    join(lines, "\n")
}
