//! Preparation and early API/hexagon dispatch; later modes return a continuation.
use super::{
    CliExit, CliOptions,
    io::{CliIo, ExitCodeError, clean_exit, exit_with, output_to},
    parse,
};
use crate::{
    api::map::ApiError,
    api::{
        cli::{ApiFlags, ApiHost, ApiRunError, ApiRunOutcome, run_api_flags_with_warning_blocking},
        real_path,
    },
    boundaries::gate::{
        BoundaryFlags, BoundaryGateError, BoundaryGateResult, BoundaryGateTextArgs,
        run_boundary_gate_text,
    },
    collapse::{
        gate::{CollapseGateArgs, CollapseGateError, CollapseGateResult, run_collapse_gate},
        render::render_collapse,
        settings::CollapseSettings,
    },
    comments::gate::{
        CommentGateError, CommentGateResult, CommentGateTextArgs, run_comment_gate_text,
    },
    config::{
        ConfigResolution, NodeKindConfigError, resolve_collapse_settings, resolve_node_kind_rules,
        resolve_thresholds, with_entry_presets,
    },
    engine::{oxc::ParseFailure, tsgo::TsgoBinary},
    env_keys::{EnvKeyError, EnvKeyReport, load_env_key_report, render_env_keys},
    extract::{
        analysis::AnalysisOptions,
        assemble::{
            AssemblyError, DataOptions, NodeFields, TextAssembly, assemble_graph_text,
            assemble_graph_with_analysis_text_and_warning,
        },
    },
    hexagon::cli::{HexagonOutput, HexagonRunError, HexagonRunOutcome, run_hexagon},
    kinds::rules::{NodeKindRules, RuleInputError},
    layers::gate::{LayerGateError, LayerGateResult, LayerGateTextArgs, run_layer_gate_text},
    project::{
        EdgeScope, ProjectLoadError, find_repo_root_text, load_cheap_project,
        load_edge_project_text, resolve_path_text_from,
    },
    render::{analysis::render_unreachable, json::stable_stringify},
    schema::{Graph, Thresholds},
    smells::{
        gate::{
            SmellGateOpts, SmellPreparation, SmellPreparationError, prepare_smell_gate,
            run_smell_ledger_gate, smell_gate_needs_edges,
        },
        ledger::{RuleNameConversionError, SmellLedgerError},
    },
    text::JsString,
    unreachable::gate::{
        UnreachableOpts, UnreachableOutput, UnreachablePreparation, UnreachableRunError,
        prepare_unreachable_gate, run_unreachable_gate,
    },
};
use std::{cell::RefCell, error::Error, fs, io, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigStage {
    Thresholds,
    NodeKinds,
    EntryPresets,
    Collapse,
}
#[derive(Debug)]
pub enum PreflightRefusal {
    NoSuchPath {
        path: JsString,
        source: io::Error,
    },
    NotDirectory {
        path: JsString,
    },
    Config {
        stage: ConfigStage,
        message: JsString,
    },
}
impl PreflightRefusal {
    pub fn message(&self) -> JsString {
        match self {
            Self::NoSuchPath { path, .. } => {
                let mut message = JsString::from("no such path: ");
                message.extend(path);
                message
            }
            Self::NotDirectory { path } => {
                let mut message = path.clone();
                message.push_str(" is not a directory");
                message
            }
            Self::Config { message, .. } => message.clone(),
        }
    }
}
#[derive(Debug)]
pub enum CliStop {
    Parser(CliExit),
    Refused(PreflightRefusal),
}
impl CliStop {
    pub fn exit_code(&self, host: &CliIo<'_>) -> i32 {
        match self {
            Self::Parser(exit) => i32::from(exit.exit_code),
            Self::Refused(_) => host.normal_exit_code(),
        }
    }
}
#[derive(Debug)]
pub struct PreparedCli {
    pub root_absolute: JsString,
    pub options: CliOptions,
    pub thresholds: Thresholds,
    pub kind_rules: NodeKindRules,
    pub collapse_settings: CollapseSettings,
}
#[derive(Debug)]
pub enum Preparation {
    Stopped(CliStop),
    Prepared(Box<PreparedCli>),
}
#[derive(Debug)]
pub enum ApiDispatch {
    Complete(ApiRunOutcome),
    Continue(Box<PreparedCli>),
}
#[derive(Debug)]
pub enum HexagonDispatch {
    Complete(HexagonRunOutcome),
    Continue(Box<PreparedCli>),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatePreparationKind {
    Unreachable,
    Smell,
}
#[derive(Debug)]
pub struct GatePreflightRefusal {
    pub stage: GatePreparationKind,
    pub message: JsString,
    pub source: Option<io::Error>,
}
#[derive(Debug)]
pub struct PreparedGatesCli {
    pub prepared: Box<PreparedCli>,
    pub repo_root: JsString,
    pub unreachable: UnreachablePreparation,
    pub smells: SmellPreparation,
}
#[derive(Debug)]
pub enum GatePreflightDispatch {
    Stopped(GatePreflightRefusal),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum LayerDispatch {
    Complete(LayerGateResult),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum BoundaryDispatch {
    Complete(BoundaryGateResult),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum CommentDispatch {
    Complete(CommentGateResult),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum CollapseDispatch {
    Complete(CollapseGateResult),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum PlainCollapseDispatch {
    Complete,
    Refused { cause: ProjectLoadError },
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum UnreachableDispatch {
    Complete,
    Refused { cause: ProjectLoadError },
    Continue(Box<PreparedGatesCli>),
}
enum ClassifiedGraphFailure {
    LoadRefused(ProjectLoadError),
    CheapParse(ParseFailure),
    Assembly(AssemblyError),
}
#[derive(Debug)]
pub enum SmellDispatch {
    Complete,
    Refused { cause: ProjectLoadError },
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum EnvKeyDispatch {
    Complete(EnvKeyReport),
    Continue(Box<PreparedGatesCli>),
}
#[derive(Debug)]
pub enum FrontdoorError {
    Resolve {
        target: JsString,
        source: io::Error,
    },
    Realpath {
        path: JsString,
        source: io::Error,
    },
    NodeKinds(NodeKindConfigError),
    Api(ApiRunError),
    Hexagon(HexagonRunError),
    Layers(LayerGateError),
    LayerEmit(ApiError),
    Boundaries(BoundaryGateError),
    BoundaryEmit(ApiError),
    Comments(CommentGateError),
    CommentEmit(ApiError),
    Collapse(CollapseGateError),
    CollapseEmit(ApiError),
    Assembly(AssemblyError),
    CheapParse(ParseFailure),
    SmellLedger(SmellLedgerError),
    SmellEmit(ApiError),
    CollapseRender(serde_json::Error),
    Unreachable(UnreachableRunError<ApiError>),
    EnvKeys(EnvKeyError),
    EnvKeyEmit(ApiError),
    RuleNameConversion(RuleNameConversionError),
    GateScope {
        stage: GatePreparationKind,
        root: JsString,
        repo_root: JsString,
        source: io::Error,
    },
    ExitCode(ExitCodeError),
}
impl FrontdoorError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::NodeKinds(NodeKindConfigError::Rules(RuleInputError::TypeError(_))) => {
                "TypeError"
            }
            Self::Api(error) => error.visible().name(),
            Self::Hexagon(error) => error.name(),
            Self::LayerEmit(error) => error.name(),
            Self::Boundaries(error) => error.name(),
            Self::BoundaryEmit(error) => error.name(),
            Self::Comments(error) => error.name(),
            Self::CommentEmit(error) => error.name(),
            Self::Collapse(error) => error.name(),
            Self::CollapseEmit(error) => error.name(),
            Self::Assembly(error) => error.name(),
            Self::SmellLedger(error) => error.name(),
            Self::SmellEmit(error) => error.name(),
            Self::Unreachable(
                UnreachableRunError::Emit(error) | UnreachableRunError::Report(error),
            ) => error.name(),
            Self::EnvKeys(error) => error.name(),
            Self::EnvKeyEmit(error) => error.name(),
            Self::RuleNameConversion(error) => error.name(),
            Self::ExitCode(error) => error.name(),
            _ => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Resolve { source, .. }
            | Self::Realpath { source, .. }
            | Self::GateScope { source, .. } => source.to_string().into(),
            Self::NodeKinds(NodeKindConfigError::Rules(RuleInputError::TypeError(message))) => {
                message.clone()
            }
            Self::NodeKinds(error) => error.to_string().into(),
            Self::Api(error) => error.message(),
            Self::Hexagon(error) => error.message(),
            Self::Layers(error) => error.to_string().into(),
            Self::LayerEmit(error) => error.message(),
            Self::Boundaries(error) => error.message(),
            Self::BoundaryEmit(error) => error.message(),
            Self::Comments(error) => error.message(),
            Self::CommentEmit(error) => error.message(),
            Self::Collapse(error) => error.message(),
            Self::CollapseEmit(error) => error.message(),
            Self::Assembly(error) => error.message(),
            Self::CheapParse(error) => error.to_string().into(),
            Self::SmellLedger(error) => error.message(),
            Self::SmellEmit(error) => error.message(),
            Self::CollapseRender(error) => error.to_string().into(),
            Self::Unreachable(error) => match error {
                UnreachableRunError::Write(error) => error.to_string().into(),
                UnreachableRunError::Render(error) => error.to_string().into(),
                UnreachableRunError::Emit(error) | UnreachableRunError::Report(error) => {
                    error.message()
                }
            },
            Self::EnvKeys(error) => error.message(),
            Self::EnvKeyEmit(error) => error.message(),
            Self::RuleNameConversion(error) => error.message(),
            Self::ExitCode(error) => error.message(),
        }
    }
}
impl std::fmt::Display for FrontdoorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message().to_lossy())
    }
}
impl Error for FrontdoorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(match self {
            Self::Resolve { source, .. }
            | Self::Realpath { source, .. }
            | Self::GateScope { source, .. } => source,
            Self::NodeKinds(error) => error,
            Self::Api(error) => error,
            Self::Hexagon(error) => error,
            Self::Layers(error) => error,
            Self::LayerEmit(error) => error,
            Self::Boundaries(error) => error,
            Self::BoundaryEmit(error) => error,
            Self::Comments(error) => error,
            Self::CommentEmit(error) => error,
            Self::Collapse(error) => error,
            Self::CollapseEmit(error) => error,
            Self::Assembly(error) => error,
            Self::CheapParse(error) => error,
            Self::SmellLedger(error) => error,
            Self::SmellEmit(error) => error,
            Self::CollapseRender(error) => error,
            Self::Unreachable(error) => match error {
                UnreachableRunError::Write(error) => error,
                UnreachableRunError::Render(error) => error,
                UnreachableRunError::Emit(error) | UnreachableRunError::Report(error) => error,
            },
            Self::EnvKeys(error) => error,
            Self::EnvKeyEmit(error) => error,
            Self::RuleNameConversion(error) => error,
            Self::ExitCode(error) => error,
        })
    }
}
fn refused(reason: PreflightRefusal, host: &mut CliIo<'_>) -> Preparation {
    clean_exit(host, &reason.message());
    Preparation::Stopped(CliStop::Refused(reason))
}
pub fn prepare_cli(
    argv: &[JsString],
    help_width: Option<usize>,
    host: &mut CliIo<'_>,
) -> Result<Preparation, FrontdoorError> {
    let parsed = parse(argv, help_width);
    if let Some(exit) = parsed.exit() {
        let stdout = parsed.stdout();
        if !stdout.is_empty() {
            host.write_stdout(&stdout);
        }
        let stderr = parsed.stderr();
        if !stderr.is_empty() {
            host.write_stderr(&stderr);
        }
        host.assign_exit(f64::from(exit.exit_code))
            .map_err(FrontdoorError::ExitCode)?;
        return Ok(Preparation::Stopped(CliStop::Parser(exit)));
    }
    let target = parsed
        .target()
        .expect("successful parser processed the required target");
    let resolved = resolve_path_text_from(&JsString::default(), target).map_err(|source| {
        FrontdoorError::Resolve {
            target: target.clone(),
            source,
        }
    })?;
    let stat = match fs::metadata(resolved.to_lossy()) {
        Ok(stat) => stat,
        Err(source) => {
            return Ok(refused(
                PreflightRefusal::NoSuchPath {
                    path: resolved,
                    source,
                },
                host,
            ));
        }
    };
    if !stat.is_dir() {
        return Ok(refused(
            PreflightRefusal::NotDirectory { path: resolved },
            host,
        ));
    }
    let root_absolute = real_path(&resolved).map_err(|source| FrontdoorError::Realpath {
        path: resolved,
        source,
    })?;
    let options = parsed.options;
    let thresholds = match resolve_thresholds(options.thresholds()) {
        ConfigResolution::Resolved(value) => value,
        ConfigResolution::Refused { message } => {
            return Ok(refused(
                PreflightRefusal::Config {
                    stage: ConfigStage::Thresholds,
                    message,
                },
                host,
            ));
        }
    };
    let rules =
        match resolve_node_kind_rules(options.node_kinds()).map_err(FrontdoorError::NodeKinds)? {
            ConfigResolution::Resolved(value) => value,
            ConfigResolution::Refused { message } => {
                return Ok(refused(
                    PreflightRefusal::Config {
                        stage: ConfigStage::NodeKinds,
                        message,
                    },
                    host,
                ));
            }
        };
    let kind_rules = match with_entry_presets(rules, options.entry_preset()) {
        ConfigResolution::Resolved(value) => value,
        ConfigResolution::Refused { message } => {
            return Ok(refused(
                PreflightRefusal::Config {
                    stage: ConfigStage::EntryPresets,
                    message,
                },
                host,
            ));
        }
    };
    let collapse_settings = match resolve_collapse_settings(options.collapse_config()) {
        ConfigResolution::Resolved(value) => value,
        ConfigResolution::Refused { message } => {
            return Ok(refused(
                PreflightRefusal::Config {
                    stage: ConfigStage::Collapse,
                    message,
                },
                host,
            ));
        }
    };
    Ok(Preparation::Prepared(Box::new(PreparedCli {
        root_absolute,
        options,
        thresholds,
        kind_rules,
        collapse_settings,
    })))
}
impl PreparedCli {
    /// Resolve both ledgers after HexagonDispatch::Continue, before dispatching a later mode.
    pub fn prepare_gates(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<GatePreflightDispatch, FrontdoorError> {
        let repo_root = find_repo_root_text(&self.root_absolute);
        let opts = &self.options;
        let unreachable = prepare_unreachable_gate(
            UnreachableOpts {
                unreachable: opts.unreachable() == Some(true),
                ci: opts.ci() == Some(true),
                accept_dead: opts.accept_dead() == Some(true),
                dead_only: opts.dead_only() == Some(true),
                boundaries: opts.boundaries() == Some(true),
                reason: opts.reason(),
            },
            &self.root_absolute,
            &repo_root,
        )
        .map_err(|source| FrontdoorError::GateScope {
            stage: GatePreparationKind::Unreachable,
            root: self.root_absolute.clone(),
            repo_root: repo_root.clone(),
            source,
        })?;
        if let UnreachablePreparation::Refused { message, source } = unreachable {
            clean_exit(host, &message);
            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {
                stage: GatePreparationKind::Unreachable,
                message,
                source,
            }));
        }
        let smells = prepare_smell_gate(
            SmellGateOpts {
                ci: opts.ci() == Some(true),
                accept_smells: opts.accept_smells() == Some(true),
                unreachable: opts.unreachable() == Some(true),
                boundaries: opts.boundaries() == Some(true),
                comments: opts.comments() == Some(true),
                collapse: opts.collapse() == Some(true),
                layers: opts.layers() == Some(true),
                reason: opts.reason(),
            },
            &self.root_absolute,
            &repo_root,
        )
        .map_err(|error| match error {
            SmellPreparationError::RuleName(error) => FrontdoorError::RuleNameConversion(error),
            SmellPreparationError::Scope(source) => FrontdoorError::GateScope {
                stage: GatePreparationKind::Smell,
                root: self.root_absolute.clone(),
                repo_root: repo_root.clone(),
                source,
            },
        })?;
        if let SmellPreparation::Refused { message, source } = smells {
            clean_exit(host, &message);
            return Ok(GatePreflightDispatch::Stopped(GatePreflightRefusal {
                stage: GatePreparationKind::Smell,
                message,
                source,
            }));
        }
        Ok(GatePreflightDispatch::Continue(Box::new(
            PreparedGatesCli {
                prepared: self,
                repo_root,
                unreachable,
                smells,
            },
        )))
    }

    /// Run the next early mode after ApiDispatch::Continue, retaining all later modes.
    pub fn dispatch_hexagon(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<HexagonDispatch, FrontdoorError> {
        if self.options.hexagon() != Some(true) {
            return Ok(HexagonDispatch::Continue(self));
        }
        let result = {
            let bridge = RefCell::new(&mut *host);
            let output = output_to(self.options.out());
            let mut emit = |payload: &JsString| output.emit(&mut bridge.borrow_mut(), payload);
            let mut report = |message: &JsString| {
                clean_exit(&mut bridge.borrow_mut(), message);
                Ok(())
            };
            run_hexagon(
                &self.root_absolute,
                HexagonOutput {
                    json: self.options.json() == Some(true),
                    pretty: self.options.pretty() == Some(true),
                    emit: &mut emit,
                    report: &mut report,
                },
            )
        }
        .map_err(FrontdoorError::Hexagon)?;
        Ok(HexagonDispatch::Complete(result))
    }

    /// The native tool calls block; inactive API flags return this owned continuation.
    pub fn dispatch_api_blocking(
        self: Box<Self>,
        compiler: &TsgoBinary,
        host: &mut CliIo<'_>,
    ) -> Result<ApiDispatch, FrontdoorError> {
        let given = self
            .options
            .given()
            .map(|id| JsString::from(id.key()))
            .collect::<Vec<_>>();
        let result = {
            let bridge = RefCell::new(&mut *host);
            let output = output_to(self.options.out());
            let mut emit = |payload: &JsString| output.emit(&mut bridge.borrow_mut(), payload);
            let mut report = |message: &JsString| {
                clean_exit(&mut bridge.borrow_mut(), message);
                Ok(())
            };
            let mut warning = |message: &JsString| {
                let mut line = message.clone();
                line.push_str("\n");
                bridge.borrow_mut().write_stderr(&line);
                Ok(())
            };
            run_api_flags_with_warning_blocking(
                ApiFlags {
                    api: self.options.api(),
                    api_base: self.options.api_base(),
                    api_policy: self.options.api_policy(),
                },
                ApiHost {
                    root_absolute: &self.root_absolute,
                    given: &given,
                    json: self.options.json() == Some(true),
                    pretty: self.options.pretty() == Some(true),
                    emit: &mut emit,
                    report: &mut report,
                },
                compiler,
                Some(&mut warning),
            )
        }
        .map_err(FrontdoorError::Api)?;
        match result {
            Some(outcome) => {
                exit_with(host, f64::from(outcome.exit.code()))
                    .map_err(FrontdoorError::ExitCode)?;
                Ok(ApiDispatch::Complete(outcome))
            }
            None => Ok(ApiDispatch::Continue(self)),
        }
    }
}

impl PreparedGatesCli {
    /// Run the early CI/record branch after comments; plain collapse retains this carrier.
    /// Compiler work is blocking. The host owns immediate warning and pending IO behavior.
    pub fn dispatch_collapse_gate(
        self: Box<Self>,
        host: &mut CliIo<'_>,
        binary: &TsgoBinary,
    ) -> Result<CollapseDispatch, FrontdoorError> {
        let options = &self.prepared.options;
        if options.collapse() != Some(true)
            || !(options.ci() == Some(true) || options.write_ceilings() == Some(true))
        {
            return Ok(CollapseDispatch::Continue(self));
        }
        let repo_root = find_repo_root_text(&self.prepared.root_absolute);
        let result = run_collapse_gate(
            CollapseGateArgs {
                root_absolute: &self.prepared.root_absolute,
                repo_root: &repo_root,
                write_ceilings: options.write_ceilings() == Some(true),
                thresholds: &self.prepared.thresholds,
                kind_rules: &self.prepared.kind_rules,
                settings: &self.prepared.collapse_settings,
                json: options.json() == Some(true),
                pretty: options.pretty() == Some(true),
            },
            binary,
            &mut |line| host.write_stderr(line),
        )
        .map_err(FrontdoorError::Collapse)?;
        for message in &result.reports {
            clean_exit(host, message);
        }
        for payload in &result.emitted {
            output_to(options.out())
                .emit(host, payload)
                .map_err(FrontdoorError::CollapseEmit)?;
        }
        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;
        Ok(CollapseDispatch::Complete(result))
    }

    fn assemble_classified_graph(
        &self,
        host: &mut CliIo<'_>,
        binary: &TsgoBinary,
    ) -> Result<Graph, ClassifiedGraphFailure> {
        let options = &self.prepared.options;
        let want_reach = options.unreachable() == Some(true) || options.unguarded() == Some(true);
        let want_kinds =
            options.kinds() == Some(true) || want_reach || options.collapse() == Some(true);
        let want_clusters = options.clusters() == Some(true);
        let want_cross_runtime =
            options.cross_runtime() == Some(true) || want_kinds || want_clusters;
        let want_interface_width = options.interface_width() == Some(true);
        let want_edges = options.edges() == Some(true)
            || options.deep() == Some(true)
            || options.blast().is_some()
            || options.find().is_some()
            || options.html() == Some(true)
            || options.cycles() == Some(true)
            || want_cross_runtime
            || want_interface_width
            || smell_gate_needs_edges(&self.smells);
        if options.plan() != Some(true)
            && let Some(by) = options.by().filter(|by| *by != "rot")
        {
            let mut warning = JsString::from("warning: --by ");
            warning.extend(by);
            warning.push_str(" has no effect without --plan.\n");
            host.write_stderr(&warning);
        }
        let root = &self.prepared.root_absolute;
        let data_root = (options.data() == Some(true)).then(|| find_repo_root_text(root));
        let data_native = data_root.as_ref().map(JsString::to_lossy);
        let data = data_native.as_ref().map(|root| DataOptions {
            repo_root: Path::new(root),
        });
        let fields = NodeFields {
            headers: options.headers() == Some(true),
        };
        if !want_edges {
            let loaded = load_cheap_project(Path::new(&root.to_lossy()), None)
                .map_err(ClassifiedGraphFailure::CheapParse)?;
            return assemble_graph_text(
                &loaded,
                root,
                self.prepared.thresholds.clone(),
                fields,
                data,
            )
            .map_err(ClassifiedGraphFailure::Assembly);
        }
        let repo_native = self.repo_root.to_lossy();
        let repo_root = Path::new(&repo_native);
        let scope = if options.deep() == Some(true) {
            EdgeScope::Deep
        } else {
            EdgeScope::Package
        };
        let loaded = match load_edge_project_text(root, scope, repo_root, None) {
            Ok(loaded) => loaded,
            Err(cause) => {
                let mut message = JsString::from("no tsconfig found for edge pass at ");
                message.extend(root);
                message.push_str("; edges unavailable");
                clean_exit(host, &message);
                return Err(ClassifiedGraphFailure::LoadRefused(cause));
            }
        };
        let analysis = (want_cross_runtime || want_interface_width).then_some(AnalysisOptions {
            cross_runtime: want_cross_runtime,
            kinds: want_kinds,
            reach: want_reach,
            clusters: want_clusters,
            interface_width: want_interface_width,
            kind_rules: &self.prepared.kind_rules,
            repo_root,
        });
        assemble_graph_with_analysis_text_and_warning(
            &loaded,
            self.prepared.thresholds.clone(),
            binary,
            fields,
            analysis.as_ref(),
            data,
            TextAssembly {
                root,
                warning: &mut |line| host.write_stderr(line),
            },
        )
        .map_err(ClassifiedGraphFailure::Assembly)
    }

    /// Run after all early modes; retain ordinary collapse and unfinished higher owners.
    pub fn dispatch_unreachable_blocking(
        self: Box<Self>,
        host: &mut CliIo<'_>,
        binary: &TsgoBinary,
    ) -> Result<UnreachableDispatch, FrontdoorError> {
        let options = &self.prepared.options;
        let prepared_gate = match &self.unreachable {
            UnreachablePreparation::Prepared { gate } => Some(gate),
            _ => None,
        };
        if prepared_gate.is_none()
            && (options.unreachable() != Some(true)
                || options.html() == Some(true)
                || options.collapse() == Some(true)
                || options.ci() == Some(true)
                || matches!(self.smells, SmellPreparation::Prepared { .. }))
        {
            return Ok(UnreachableDispatch::Continue(self));
        }
        let graph = match self.assemble_classified_graph(host, binary) {
            Ok(graph) => graph,
            Err(ClassifiedGraphFailure::LoadRefused(cause)) => {
                return Ok(UnreachableDispatch::Refused { cause });
            }
            Err(ClassifiedGraphFailure::Assembly(cause)) => {
                return Err(FrontdoorError::Assembly(cause));
            }
            Err(ClassifiedGraphFailure::CheapParse(cause)) => {
                return Err(FrontdoorError::CheapParse(cause));
            }
        };
        if let Some(gate) = prepared_gate {
            let code = {
                let bridge = RefCell::new(&mut *host);
                let mut emit = |payload: &JsString| {
                    output_to(options.out()).emit(&mut bridge.borrow_mut(), payload)
                };
                let mut report = |message: &JsString| {
                    clean_exit(&mut bridge.borrow_mut(), message);
                    Ok(())
                };
                run_unreachable_gate(
                    gate,
                    &graph,
                    UnreachableOutput {
                        emit: &mut emit,
                        report: &mut report,
                        json: options.json() == Some(true),
                        pretty: options.pretty() == Some(true),
                    },
                )
                .map_err(FrontdoorError::Unreachable)?
            };
            exit_with(host, f64::from(code)).map_err(FrontdoorError::ExitCode)?;
            return Ok(UnreachableDispatch::Complete);
        }
        let mut rendered = if options.graph() == Some(true) {
            stable_stringify(&graph, options.pretty() == Some(true)).map(Into::into)
        } else {
            render_unreachable(
                &graph,
                options.json() == Some(true),
                options.pretty() == Some(true),
            )
        }
        .map_err(|error| FrontdoorError::Unreachable(UnreachableRunError::Render(error)))?;
        rendered.push_str("\n");
        output_to(options.out())
            .emit(host, &rendered)
            .map_err(|error| FrontdoorError::Unreachable(UnreachableRunError::Emit(error)))?;
        Ok(UnreachableDispatch::Complete)
    }

    /// Run a prepared smell ledger after unreachable and before later output modes.
    pub fn dispatch_smell_ledger_blocking(
        self: Box<Self>,
        host: &mut CliIo<'_>,
        binary: &TsgoBinary,
    ) -> Result<SmellDispatch, FrontdoorError> {
        let gate = match &self.smells {
            SmellPreparation::Prepared { gate } => gate,
            _ => return Ok(SmellDispatch::Continue(self)),
        };
        let graph = match self.assemble_classified_graph(host, binary) {
            Ok(graph) => graph,
            Err(ClassifiedGraphFailure::LoadRefused(cause)) => {
                return Ok(SmellDispatch::Refused { cause });
            }
            Err(ClassifiedGraphFailure::Assembly(cause)) => {
                return Err(FrontdoorError::Assembly(cause));
            }
            Err(ClassifiedGraphFailure::CheapParse(cause)) => {
                return Err(FrontdoorError::CheapParse(cause));
            }
        };
        let options = &self.prepared.options;
        let result = run_smell_ledger_gate(
            gate,
            &graph,
            options.json() == Some(true),
            options.pretty() == Some(true),
        )
        .map_err(FrontdoorError::SmellLedger)?;
        output_to(options.out())
            .emit(host, &result.stdout)
            .map_err(FrontdoorError::SmellEmit)?;
        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;
        Ok(SmellDispatch::Complete)
    }

    /// Run after the early collapse gate. Higher late owners retain the original continuation.
    /// Compiler, Git and filesystem work blocks this caller; the host owns warning/stdio delivery.
    pub fn dispatch_plain_collapse_blocking(
        self: Box<Self>,
        host: &mut CliIo<'_>,
        binary: &TsgoBinary,
    ) -> Result<PlainCollapseDispatch, FrontdoorError> {
        let options = &self.prepared.options;
        if options.collapse() != Some(true)
            || options.ci() == Some(true)
            || options.write_ceilings() == Some(true)
            || options.html() == Some(true)
            || matches!(self.unreachable, UnreachablePreparation::Prepared { .. })
            || matches!(self.smells, SmellPreparation::Prepared { .. })
        {
            return Ok(PlainCollapseDispatch::Continue(self));
        }
        let graph = match self.assemble_classified_graph(host, binary) {
            Ok(graph) => graph,
            Err(ClassifiedGraphFailure::LoadRefused(cause)) => {
                return Ok(PlainCollapseDispatch::Refused { cause });
            }
            Err(ClassifiedGraphFailure::Assembly(cause)) => {
                return Err(FrontdoorError::Assembly(cause));
            }
            Err(ClassifiedGraphFailure::CheapParse(cause)) => {
                return Err(FrontdoorError::CheapParse(cause));
            }
        };
        let root = &self.prepared.root_absolute;
        let mut payload = if options.graph() == Some(true) {
            stable_stringify(&graph, options.pretty() == Some(true)).map(Into::into)
        } else {
            render_collapse(
                &graph,
                root,
                &self.prepared.collapse_settings,
                options.json() == Some(true),
                options.pretty() == Some(true),
            )
        }
        .map_err(FrontdoorError::CollapseRender)?;
        payload.push_str("\n");
        output_to(options.out())
            .emit(host, &payload)
            .map_err(FrontdoorError::CollapseEmit)?;
        Ok(PlainCollapseDispatch::Complete)
    }

    /// Run comments after environment keys, or retain the same continuation.
    pub fn dispatch_comments(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<CommentDispatch, FrontdoorError> {
        if self.prepared.options.comments() != Some(true) {
            return Ok(CommentDispatch::Continue(self));
        }
        let repo_root = find_repo_root_text(&self.prepared.root_absolute);
        let options = &self.prepared.options;
        let result = run_comment_gate_text(CommentGateTextArgs {
            root_absolute: &self.prepared.root_absolute,
            repo_root: &repo_root,
            ci: options.ci() == Some(true),
            write_ceilings: options.write_ceilings() == Some(true),
            json: options.json() == Some(true),
            pretty: options.pretty() == Some(true),
        })
        .map_err(FrontdoorError::Comments)?;
        for message in &result.reports {
            clean_exit(host, message);
        }
        for payload in &result.emitted {
            output_to(options.out())
                .emit(host, payload)
                .map_err(FrontdoorError::CommentEmit)?;
        }
        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;
        Ok(CommentDispatch::Complete(result))
    }

    /// Read and emit environment keys after boundaries, or retain the same continuation.
    pub fn dispatch_env_keys(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<EnvKeyDispatch, FrontdoorError> {
        if self.prepared.options.env_keys() != Some(true) {
            return Ok(EnvKeyDispatch::Continue(self));
        }
        let repo_root = find_repo_root_text(&self.prepared.root_absolute);
        let report = load_env_key_report(&self.prepared.root_absolute, &repo_root)
            .map_err(FrontdoorError::EnvKeys)?;
        let mut payload = render_env_keys(
            &report,
            self.prepared.options.json() == Some(true),
            self.prepared.options.pretty() == Some(true),
        )
        .map_err(|error| FrontdoorError::EnvKeys(EnvKeyError::Render(error)))?;
        payload.push_str("\n");
        output_to(self.prepared.options.out())
            .emit(host, &payload)
            .map_err(FrontdoorError::EnvKeyEmit)?;
        Ok(EnvKeyDispatch::Complete(report))
    }

    /// Run boundaries after layers, or retain the same continuation for later modes.
    pub fn dispatch_boundaries(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<BoundaryDispatch, FrontdoorError> {
        if self.prepared.options.boundaries() != Some(true) {
            return Ok(BoundaryDispatch::Continue(self));
        }
        let repo_root = find_repo_root_text(&self.prepared.root_absolute);
        let options = &self.prepared.options;
        let result = run_boundary_gate_text(BoundaryGateTextArgs {
            root_absolute: &self.prepared.root_absolute,
            repo_root: &repo_root,
            boundary_rules_file: options.boundary_rules(),
            flags: BoundaryFlags {
                ci: options.ci() == Some(true),
                write_ceilings: options.write_ceilings() == Some(true),
                accept_crossings: options.accept_crossings() == Some(true),
                reason: options.reason(),
                migrate_ceilings: options.migrate_ceilings() == Some(true),
            },
            json: options.json() == Some(true),
            pretty: options.pretty() == Some(true),
        })
        .map_err(FrontdoorError::Boundaries)?;
        for message in &result.reports {
            clean_exit(host, message);
        }
        for payload in &result.emitted {
            output_to(options.out())
                .emit(host, payload)
                .map_err(FrontdoorError::BoundaryEmit)?;
        }
        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;
        Ok(BoundaryDispatch::Complete(result))
    }

    /// Run layers after both preparations, or retain the same continuation for later modes.
    pub fn dispatch_layers(
        self: Box<Self>,
        host: &mut CliIo<'_>,
    ) -> Result<LayerDispatch, FrontdoorError> {
        if self.prepared.options.layers() != Some(true) {
            return Ok(LayerDispatch::Continue(self));
        }
        let repo_root = find_repo_root_text(&self.prepared.root_absolute);
        let result = run_layer_gate_text(LayerGateTextArgs {
            root_absolute: &self.prepared.root_absolute,
            repo_root: &repo_root,
            layer_rules_file: self.prepared.options.layer_rules(),
            json: self.prepared.options.json() == Some(true),
            pretty: self.prepared.options.pretty() == Some(true),
        })
        .map_err(FrontdoorError::Layers)?;
        for message in &result.reports {
            clean_exit(host, message);
        }
        for payload in &result.emitted {
            output_to(self.prepared.options.out())
                .emit(host, payload)
                .map_err(FrontdoorError::LayerEmit)?;
        }
        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;
        Ok(LayerDispatch::Complete(result))
    }
}
