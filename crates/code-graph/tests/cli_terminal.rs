use demlik_code_graph::{cli::terminal::TerminalFacts, render::tree::TreeStyle};

#[test]
fn pinned_chalk_environment_precedence_and_decimal_prefixes() {
    // Whole-process tests own ordinary pipes/PTYs. These cases protect Chalk's
    // less common host precedence and JS parseInt edge cases independently.
    let cases: &[(&[(&str, &str)], TreeStyle)] = &[
        (
            &[("FORCE_COLOR", "garbage"), ("TERM", "dumb")],
            TreeStyle::Plain,
        ),
        (
            &[("FORCE_COLOR", "garbage"), ("TERM", "xterm")],
            TreeStyle::Ansi,
        ),
        (&[("FORCE_COLOR", "-1"), ("TERM", "dumb")], TreeStyle::Plain),
        (&[("FORCE_COLOR", "-1"), ("TERM", "xterm")], TreeStyle::Ansi),
        (
            &[("FORCE_COLOR", "  +1suffix"), ("TERM", "dumb")],
            TreeStyle::Ansi,
        ),
        (
            &[("FORCE_COLOR", "0xff"), ("TERM", "xterm")],
            TreeStyle::Plain,
        ),
        (&[("CI", ""), ("TERM", "xterm")], TreeStyle::Plain),
        (&[("CI", ""), ("GITHUB_ACTIONS", "false")], TreeStyle::Ansi),
        (&[("CI", ""), ("FORCE_COLOR", "1")], TreeStyle::Ansi),
        (
            &[("CI", ""), ("GITHUB_ACTIONS", "1"), ("FORCE_COLOR", "0")],
            TreeStyle::Plain,
        ),
        (&[("TEAMCITY_VERSION", "9.0.1")], TreeStyle::Plain),
        (&[("TEAMCITY_VERSION", "9.01.1")], TreeStyle::Ansi),
        (&[("TEAMCITY_VERSION", "10.0")], TreeStyle::Ansi),
        (&[("TERM_PROGRAM", "Apple_Terminal")], TreeStyle::Ansi),
        (&[("TERM_PROGRAM", "iTerm.app")], TreeStyle::Ansi),
        (&[("COLORTERM", "")], TreeStyle::Ansi),
        (&[("NO_COLOR", "1"), ("TERM", "xterm")], TreeStyle::Ansi),
    ];
    for (environment, expected) in cases {
        let facts = TerminalFacts {
            stdout_is_terminal: true,
            environment: environment
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            arguments: vec![],
        };
        assert_eq!(facts.tree_style(), *expected, "{environment:?}");
    }
}
