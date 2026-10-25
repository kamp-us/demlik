use demlik_code_graph::{
    cli::{OptionId, OptionSource, ParseOutcome, parse},
    text::JsString,
};
#[test]
fn api_caller_receives_raw_target_repeated_presets_and_explicit_default_sources_in_opts_order() {
    let argv = [
        "--hotspots-limit",
        "20",
        "--by",
        "rot",
        "--entry-preset",
        "nextjs",
        "--entry-preset=unknown",
        "--json",
        "src",
        "extra",
    ]
    .map(JsString::from);
    let parsed = parse(&argv, Some(80));
    assert_eq!(parsed.target().unwrap(), "src");
    assert_eq!(
        parsed.arguments,
        vec![JsString::from("src"), JsString::from("extra")]
    );
    assert_eq!(parsed.options.by().unwrap(), "rot");
    assert_eq!(parsed.options.json(), Some(true));
    assert_eq!(
        parsed.options.entry_preset(),
        &[JsString::from("nextjs"), JsString::from("unknown")]
    );
    assert_eq!(parsed.options.source(OptionId::By), Some(OptionSource::Cli));
    assert_eq!(
        parsed.options.source(OptionId::FailOn),
        Some(OptionSource::Default)
    );
    assert_eq!(
        parsed.options.given().collect::<Vec<_>>(),
        vec![
            OptionId::By,
            OptionId::EntryPreset,
            OptionId::HotspotsLimit,
            OptionId::Json
        ]
    );
}

#[test]
fn help_wins_over_unknown_and_missing_target_but_not_a_missing_option_value() {
    let help = parse(&["--unknown".into(), "--help".into()], Some(80));
    assert_eq!(help.exit_code(), 0);
    assert!(
        help.stdout()
            .starts_with("Usage: code-graph [options] <path>\n\n")
    );
    assert!(help.stderr().is_empty());
    assert!(matches!(help.outcome, ParseOutcome::Help { .. }));

    let missing = parse(&["src".into(), "--help".into(), "--by".into()], None);
    assert_eq!(missing.exit_code(), 1);
    assert_eq!(
        missing.stderr(),
        "error: option '--by <axis>' argument missing\n"
    );
    assert!(missing.arguments.is_empty());
    assert!(missing.stdout().is_empty());
}

#[test]
fn unknown_option_suggestions_match_commander_and_keep_raw_code_units() {
    let suggestion = parse(&["--pritty".into(), "src".into()], None);
    assert_eq!(
        suggestion.stderr(),
        "error: unknown option '--pritty'\n(Did you mean --pretty?)\n"
    );
    let raw = JsString::from_units(vec![45, 45, 0xd800, 0]);
    let parsed = parse(std::slice::from_ref(&raw), None);
    let mut expected = JsString::from("error: unknown option '");
    expected.extend(&raw);
    expected.push_str("'\n");
    assert_eq!(parsed.stderr(), expected);
}

#[test]
fn each_parse_owns_fresh_defaults_and_literal_termination_preserves_target() {
    let first = parse(&["--entry-preset=first".into(), "src".into()], None);
    assert_eq!(first.options.entry_preset(), &[JsString::from("first")]);
    let second = parse(&["--".into(), "--help".into(), "--json".into()], None);
    assert!(second.options.entry_preset().is_empty());
    assert_eq!(
        second.options.source(OptionId::EntryPreset),
        Some(OptionSource::Default)
    );
    assert_eq!(second.target().unwrap(), "--help");
    assert_eq!(second.options.json(), None);
    assert_eq!(second.processed_arguments(), &[JsString::from("--help")]);
}

#[test]
fn api_companion_handoff_uses_typed_values_and_explicit_sources_from_one_owner() {
    let argv = [
        "src/package",
        "--api=api.json",
        "--api-base",
        "HEAD",
        "--api-policy=policy.json",
        "--out=report.json",
        "--pretty",
        "--json",
        "--by=rot",
    ]
    .map(JsString::from);
    let parsed = parse(&argv, None);
    let options = &parsed.options;
    assert_eq!(parsed.target().unwrap(), "src/package");
    assert_eq!(options.api().unwrap(), "api.json");
    assert_eq!(options.api_base().unwrap(), "HEAD");
    assert_eq!(options.api_policy().unwrap(), "policy.json");
    assert_eq!(options.out().unwrap(), "report.json");
    assert_eq!(options.pretty(), Some(true));
    assert_eq!(options.json(), Some(true));
    assert_eq!(options.by().unwrap(), "rot");
    assert_eq!(
        options.given().map(|id| id.key()).collect::<Vec<_>>(),
        ["by", "api", "apiBase", "apiPolicy", "out", "pretty", "json",]
    );
    // An absent flag stays absent, and default-valued options remain typed text.
    assert_eq!(options.graph(), None);
    assert_eq!(options.hotspots_days().unwrap(), "90");
    assert_eq!(options.hotspots_limit().unwrap(), "20");
    assert!(parsed.exit().is_none());
}
