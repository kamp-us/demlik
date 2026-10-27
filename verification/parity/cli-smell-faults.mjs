const front = "crates/code-graph/src/cli/frontdoor.rs";
export const cliSmellFaults = [
  {
    name: "cheap-mode-forces-edge-load",
    kind: "smell-cli",
    file: front,
    witness: "cheap-ci-text",
    edits: [["        if !want_edges {", "        if false && !want_edges {"]],
  },
  {
    name: "ledger-edge-requirement-omitted",
    kind: "smell-cli",
    file: front,
    witness: "edge-fanin-ci",
    edits: [
      ["            || smell_gate_needs_edges(&self.smells);", "            ;"],
    ],
  },
  {
    name: "edge-only-eager-catalog",
    kind: "smell-cli",
    file: front,
    witness: "edge-only-does-not-read-catalog",
    edits: [
      [
        "let analysis = (want_cross_runtime || want_interface_width).then_some(AnalysisOptions {",
        "let analysis = true.then_some(AnalysisOptions {",
      ],
      [
        "            cross_runtime: want_cross_runtime,",
        "            cross_runtime: true,",
      ],
    ],
  },
  {
    name: "cheap-data-omitted",
    kind: "smell-cli",
    file: front,
    witness: "data-catalog-failure",
    edits: [
      [
        `            return assemble_graph_text(
                &loaded,
                root,
                self.prepared.thresholds.clone(),
                fields,
                data,`,
        `            return assemble_graph_text(
                &loaded,
                root,
                self.prepared.thresholds.clone(),
                fields,
                None,`,
      ],
    ],
  },
  {
    name: "ledger-root-recomputed-after-warning",
    kind: "smell-cli",
    file: "crates/code-graph/src/smells/gate.rs",
    witness: "fresh-data-stored-ledger-root",
    edits: [
      [
        "write_smell_ledger(&gate.file, &with_accepted_smells(&result, reason))?;",
        "write_smell_ledger(&crate::project::join_path_text(&crate::project::find_repo_root_text(&graph.root), &SMELL_LEDGER_FILENAME.into()), &with_accepted_smells(&result, reason))?;",
      ],
    ],
  },
  {
    name: "smell-output-before-ledger-write",
    kind: "smell-cli",
    file: front,
    witness: "ledger-write-before-out-failure",
    edits: [
      [
        "        let result = run_smell_ledger_gate(",
        "        output_to(options.out()).emit(host, &JsString::default()).map_err(FrontdoorError::SmellEmit)?;\n        let result = run_smell_ledger_gate(",
      ],
    ],
  },
  {
    name: "prepared-smell-yields-to-html",
    kind: "smell-cli",
    file: front,
    witness: "html-does-not-preempt-smell",
    edits: [
      [
        "    ) -> Result<SmellDispatch, FrontdoorError> {\n",
        "    ) -> Result<SmellDispatch, FrontdoorError> {\n        if self.prepared.options.html() == Some(true) { return Ok(SmellDispatch::Continue(self)); }\n",
      ],
    ],
  },
];
