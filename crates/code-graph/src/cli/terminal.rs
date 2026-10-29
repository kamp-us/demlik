//! Stdout styling adapted from Chalk 5.6.2's vendored supports-color.
//! Only basic ANSI styles are rendered, so positive support levels collapse to Ansi.
//! MIT License, Copyright Sindre Sorhus; see licenses/Chalk-LICENSE.
use std::collections::BTreeMap;

use crate::render::tree::TreeStyle;

pub struct TerminalFacts {
    pub stdout_is_terminal: bool,
    pub environment: BTreeMap<String, String>,
    pub arguments: Vec<String>,
}

impl TerminalFacts {
    pub fn snapshot(stdout_is_terminal: bool) -> Self {
        Self {
            stdout_is_terminal,
            environment: [
                "FORCE_COLOR",
                "TF_BUILD",
                "AGENT_NAME",
                "TERM",
                "CI",
                "GITHUB_ACTIONS",
                "GITEA_ACTIONS",
                "CIRCLECI",
                "TRAVIS",
                "APPVEYOR",
                "GITLAB_CI",
                "BUILDKITE",
                "DRONE",
                "CI_NAME",
                "TEAMCITY_VERSION",
                "COLORTERM",
                "TERM_PROGRAM",
            ]
            .into_iter()
            .filter_map(|key| {
                std::env::var_os(key)
                    .map(|value| (key.to_owned(), value.to_string_lossy().into_owned()))
            })
            .collect(),
            arguments: std::env::args_os()
                .map(|value| value.to_string_lossy().into_owned())
                .collect(),
        }
    }

    pub fn tree_style(&self) -> TreeStyle {
        if self.supports_basic_color() {
            TreeStyle::Ansi
        } else {
            TreeStyle::Plain
        }
    }

    fn supports_basic_color(&self) -> bool {
        let env = &self.environment;
        let get = |key: &str| env.get(key).map(String::as_str).unwrap_or("");
        let has_flag = |flags: &[&str]| {
            self.arguments
                .iter()
                .take_while(|arg| arg.as_str() != "--")
                .any(|arg| flags.contains(&arg.as_str()))
        };
        let flag_force = if has_flag(&[
            "--no-color",
            "--no-colors",
            "--color=false",
            "--color=never",
        ]) {
            Some(0.0)
        } else if has_flag(&["--color", "--colors", "--color=true", "--color=always"]) {
            Some(1.0)
        } else {
            None
        };
        let force = env
            .get("FORCE_COLOR")
            .map(|value| match value.as_str() {
                "true" | "" => 1.0,
                "false" => 0.0,
                value => {
                    let parsed = parse_decimal_prefix(value);
                    if parsed.is_nan() {
                        parsed
                    } else {
                        parsed.min(3.0)
                    }
                }
            })
            .or(flag_force);
        if force == Some(0.0) {
            return false;
        }
        if has_flag(&[
            "--color=16m",
            "--color=full",
            "--color=truecolor",
            "--color=256",
        ]) {
            return true;
        }
        if env.contains_key("TF_BUILD") && env.contains_key("AGENT_NAME") {
            return true;
        }
        if !self.stdout_is_terminal && force.is_none() {
            return false;
        }
        let minimum = force.unwrap_or(0.0) > 0.0;
        if get("TERM") == "dumb" {
            return minimum;
        }
        // Windows release/build probing is outside the admitted Unix host profile.
        if cfg!(windows) {
            return true;
        }
        if env.contains_key("CI") {
            return [
                "GITHUB_ACTIONS",
                "GITEA_ACTIONS",
                "CIRCLECI",
                "TRAVIS",
                "APPVEYOR",
                "GITLAB_CI",
                "BUILDKITE",
                "DRONE",
            ]
            .iter()
            .any(|key| env.contains_key(*key))
                || get("CI_NAME") == "codeship"
                || minimum;
        }
        if env.contains_key("TEAMCITY_VERSION") {
            return regress::Regex::new(r"^(9\.(0*[1-9]\d*)\.|\d{2,}\.)")
                .expect("fixed Chalk pattern")
                .find(get("TEAMCITY_VERSION"))
                .is_some();
        }
        if get("COLORTERM") == "truecolor"
            || ["xterm-kitty", "xterm-ghostty", "wezterm"].contains(&get("TERM"))
        {
            return true;
        }
        if ["iTerm.app", "Apple_Terminal"].contains(&get("TERM_PROGRAM")) {
            return true;
        }
        let term = get("TERM").to_ascii_lowercase();
        if term.ends_with("-256") || term.ends_with("-256color") {
            return true;
        }
        if ["screen", "xterm", "vt100", "vt220", "rxvt"]
            .iter()
            .any(|prefix| term.starts_with(prefix))
            || ["color", "ansi", "cygwin", "linux"]
                .iter()
                .any(|part| term.contains(part))
        {
            return true;
        }
        env.contains_key("COLORTERM") || minimum
    }
}

fn parse_decimal_prefix(value: &str) -> f64 {
    let value = value.trim_start_matches(crate::text::js_space);
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    let count = digits.bytes().take_while(u8::is_ascii_digit).count();
    if count == 0 {
        return f64::NAN;
    }
    let sign = value.len() - digits.len();
    value[..sign + count].parse().unwrap_or(f64::NAN)
}
