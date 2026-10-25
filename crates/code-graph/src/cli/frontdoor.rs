//! Preparation through API dispatch; every other mode is an explicit continuation.
use super::{
    CliExit, CliOptions,
    io::{CliIo, ExitCodeError, clean_exit, exit_with, output_to},
    parse,
};
use crate::{
    api::{
        cli::{ApiFlags, ApiHost, ApiRunError, ApiRunOutcome, run_api_flags_with_warning_blocking},
        real_path,
    },
    collapse::settings::CollapseSettings,
    config::{
        ConfigResolution, NodeKindConfigError, resolve_collapse_settings, resolve_node_kind_rules,
        resolve_thresholds, with_entry_presets,
    },
    engine::tsgo::TsgoBinary,
    kinds::rules::{NodeKindRules, RuleInputError},
    project::resolve_path_text_from,
    schema::Thresholds,
    text::JsString,
};
use std::{cell::RefCell, error::Error, fs, io};

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
pub enum FrontdoorError {
    Resolve { target: JsString, source: io::Error },
    Realpath { path: JsString, source: io::Error },
    NodeKinds(NodeKindConfigError),
    Api(ApiRunError),
    ExitCode(ExitCodeError),
}
impl FrontdoorError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::NodeKinds(NodeKindConfigError::Rules(RuleInputError::TypeError(_))) => {
                "TypeError"
            }
            Self::Api(error) => error.visible().name(),
            Self::ExitCode(error) => error.name(),
            _ => "Error",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::Resolve { source, .. } | Self::Realpath { source, .. } => {
                source.to_string().into()
            }
            Self::NodeKinds(NodeKindConfigError::Rules(RuleInputError::TypeError(message))) => {
                message.clone()
            }
            Self::NodeKinds(error) => error.to_string().into(),
            Self::Api(error) => error.message(),
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
            Self::Resolve { source, .. } | Self::Realpath { source, .. } => source,
            Self::NodeKinds(error) => error,
            Self::Api(error) => error,
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
