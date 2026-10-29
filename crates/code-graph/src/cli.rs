//! The fixed code-graph command's native argv contract.
//!
//! `parse` accepts user arguments, excluding the executable, and returns output
//! and exit decisions as data. It performs no graph execution or host IO.
pub mod frontdoor;
mod help;
pub mod io;
pub mod terminal;
mod options;
mod suggest;
use crate::text::JsString;
pub use options::{
    CliOptions, DefaultValue, Description, OPTION_SPECS, OptionId, OptionSource, OptionSpec,
    OptionValue, ValueKind,
};
#[derive(Debug)]
pub struct CliParse {
    pub options: CliOptions,
    pub arguments: Vec<JsString>,
    pub outcome: ParseOutcome,
}
#[derive(Debug)]
pub enum ParseOutcome {
    Parsed,
    Help { text: JsString },
    Refused(CliParseError),
}
#[derive(Debug)]
pub enum CliParseError {
    MissingPath,
    MissingOptionValue(OptionId),
    UnknownOption(JsString),
}
#[derive(Debug)]
pub struct CliExit {
    pub name: &'static str,
    pub code: &'static str,
    pub exit_code: u8,
    pub message: JsString,
}
impl CliParseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingPath => "commander.missingArgument",
            Self::MissingOptionValue(_) => "commander.optionMissingArgument",
            Self::UnknownOption(_) => "commander.unknownOption",
        }
    }
    pub fn message(&self) -> JsString {
        match self {
            Self::MissingPath => "error: missing required argument 'path'".into(),
            Self::MissingOptionValue(id) => {
                format!("error: option '{}' argument missing", id.spec().flags).into()
            }
            Self::UnknownOption(flag) => {
                let mut out = JsString::from("error: unknown option '");
                out.extend(flag);
                out.push_str("'");
                out.push_str(&suggest::similar(flag));
                out
            }
        }
    }
}
impl CliParse {
    pub fn exit(&self) -> Option<CliExit> {
        let (code, message) = match &self.outcome {
            ParseOutcome::Parsed => return None,
            ParseOutcome::Help { .. } => ("commander.helpDisplayed", "(outputHelp)".into()),
            ParseOutcome::Refused(error) => (error.code(), error.message()),
        };
        Some(CliExit {
            name: "CommanderError",
            code,
            exit_code: self.exit_code(),
            message,
        })
    }
    pub fn target(&self) -> Option<&JsString> {
        matches!(self.outcome, ParseOutcome::Parsed)
            .then(|| self.arguments.first())
            .flatten()
    }
    pub fn processed_arguments(&self) -> &[JsString] {
        if matches!(self.outcome, ParseOutcome::Parsed) {
            &self.arguments[..1]
        } else {
            &[]
        }
    }
    pub fn exit_code(&self) -> u8 {
        if matches!(self.outcome, ParseOutcome::Refused(_)) {
            1
        } else {
            0
        }
    }
    pub fn stdout(&self) -> JsString {
        match &self.outcome {
            ParseOutcome::Help { text } => text.clone(),
            _ => JsString::default(),
        }
    }
    pub fn stderr(&self) -> JsString {
        match &self.outcome {
            ParseOutcome::Refused(error) => {
                let mut text = error.message();
                text.push_str("\n");
                text
            }
            _ => JsString::default(),
        }
    }
}
fn option(argument: &JsString) -> Option<&'static OptionSpec> {
    OPTION_SPECS.iter().find(|spec| argument == spec.long())
}
fn maybe_option(argument: &JsString) -> bool {
    argument.units().len() > 1 && argument.units()[0] == 45
}
// Fixed-command adaptation of Commander11.1.0 lib/command.js parseOptions
// (1432-1548). No subcommands, variadics, env/config sources or optional values
// exist in this command. See cli/COMMANDER-LICENSE for the upstream MIT license.
pub fn parse(argv: &[JsString], help_width: Option<usize>) -> CliParse {
    let mut options = CliOptions::new();
    let mut operands = Vec::new();
    let mut unknown = Vec::new();
    let mut unknown_destination = false;
    let mut remaining = argv.iter();
    while let Some(argument) = remaining.next() {
        if argument == "--" {
            let destination = if unknown_destination {
                unknown.push(argument.clone());
                &mut unknown
            } else {
                &mut operands
            };
            destination.extend(remaining.cloned());
            break;
        }
        if maybe_option(argument)
            && let Some(spec) = option(argument)
        {
            if spec.kind == ValueKind::Flag {
                options.apply(spec.id, None);
            } else {
                let Some(value) = remaining.next() else {
                    return CliParse {
                        options,
                        arguments: Vec::new(),
                        outcome: ParseOutcome::Refused(CliParseError::MissingOptionValue(spec.id)),
                    };
                };
                options.apply(spec.id, Some(value.clone()));
            }
            continue;
        }
        if argument.starts_with("--")
            && let Some(index) = argument.units().iter().position(|unit| *unit == 61)
        {
            let flag = JsString::from_units(argument.units()[..index].to_vec());
            if let Some(spec) = option(&flag)
                && spec.kind != ValueKind::Flag
            {
                options.apply(
                    spec.id,
                    Some(JsString::from_units(argument.units()[index + 1..].to_vec())),
                );
                continue;
            }
        }
        if maybe_option(argument) {
            unknown_destination = true;
        }
        if unknown_destination {
            unknown.push(argument.clone());
        } else {
            operands.push(argument.clone());
        }
    }
    let help = unknown
        .iter()
        .any(|argument| argument == "--help" || argument == "-h");
    let refusal = unknown.first().cloned();
    operands.extend(unknown);
    let outcome = if help {
        ParseOutcome::Help {
            text: help_information(help_width),
        }
    } else if let Some(flag) = refusal {
        ParseOutcome::Refused(CliParseError::UnknownOption(flag))
    } else if operands.is_empty() {
        ParseOutcome::Refused(CliParseError::MissingPath)
    } else {
        ParseOutcome::Parsed
    };
    CliParse {
        options,
        arguments: operands,
        outcome,
    }
}

pub fn help_information(width: Option<usize>) -> JsString {
    help::information(width)
}
