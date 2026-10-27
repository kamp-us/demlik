const front = "crates/code-graph/src/cli/frontdoor.rs";
const render = "crates/code-graph/src/render/analysis.rs";
export const cliUnreachableFaults = [
  {
    name: "unreachable-gate-bypassed-by-graph",
    kind: "unreachable-cli",
    file: front,
    witness: "gate-before-graph",
    edits: [
      [
        "        if prepared_gate.is_none()\n",
        "        let prepared_gate = if options.graph() == Some(true) { None } else { prepared_gate };\n        if prepared_gate.is_none()\n",
      ],
    ],
  },
  {
    name: "unreachable-accept-bypassed-by-collapse",
    kind: "unreachable-cli",
    file: front,
    witness: "accept-before-collapse",
    edits: [
      [
        "        if prepared_gate.is_none()\n",
        "        let prepared_gate = if options.collapse() == Some(true) { None } else { prepared_gate };\n        if prepared_gate.is_none()\n",
      ],
    ],
  },
  {
    name: "unreachable-preempts-ordinary-collapse",
    kind: "unreachable-cli",
    file: front,
    witness: "collapse-before-report",
    edits: [["                || options.collapse() == Some(true)\n", ""]],
  },
  {
    name: "unreachable-report-preempts-graph",
    kind: "unreachable-cli",
    file: front,
    witness: "graph-before-report",
    edits: [
      [
        "        let mut rendered = if options.graph() == Some(true) {",
        "        let mut rendered = if false && options.graph() == Some(true) {",
      ],
    ],
  },
  {
    name: "unreachable-exit-zero-clears-prior",
    kind: "unreachable-cli",
    file: front,
    witness: "ci-zero-initial",
    edits: [
      [
        "            exit_with(host, f64::from(code)).map_err(FrontdoorError::ExitCode)?;",
        "            host.assign_exit(f64::from(code)).map_err(FrontdoorError::ExitCode)?;",
      ],
    ],
  },
  {
    name: "unreachable-json-leaks-other-report-fields",
    kind: "unreachable-render",
    file: render,
    witness: "json-projection",
    edits: [
      [
        "            entry_count: &'a usize,",
        "            entry_count: &'a usize,\n            exported_count: &'a usize,",
      ],
      [
        "                entry_count: &report.entry_count,",
        "                entry_count: &report.entry_count,\n                exported_count: &report.exported_count,",
      ],
    ],
  },
  {
    name: "unreachable-test-reference-witness-lost",
    kind: "unreachable-render",
    file: render,
    witness: "test-witnesses",
    edits: [
      [
        "let witness = if symbol.test_references.is_empty() {",
        "let witness = if true {",
      ],
    ],
  },
  {
    name: "unreachable-withheld-tally-wrong",
    kind: "unreachable-render",
    file: render,
    witness: "withheld-tally",
    edits: [
      [
        "*counts.entry(symbol.reason.as_str()).or_insert(0_usize) += 1;",
        "*counts.entry(symbol.reason.as_str()).or_insert(0_usize) += 2;",
      ],
    ],
  },
];
