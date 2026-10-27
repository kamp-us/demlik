const render = "crates/code-graph/src/collapse/render.rs",
  front = "crates/code-graph/src/cli/frontdoor.rs",
  io = "crates/code-graph/src/cli/io.rs",
  partial = "crates/code-graph/src/collapse/partial.rs";
const warning = `        if options.plan() != Some(true)
            && let Some(by) = options.by().filter(|by| *by != "rot")
        {
            let mut warning = JsString::from("warning: --by ");
            warning.extend(by);
            warning.push_str(" has no effect without --plan.\\n");
            host.write_stderr(&warning);
        }
`;
const ack = `        let mut line = JsString::from(format!("code-graph: wrote {} bytes to ", bytes.len()));\n        line.extend(destination);\n        line.push_str("\\n");\n        host.write_stderr(&line);\n`;
export const collapseRenderCliFaults = [
  {
    name: "cheap-pass-does-work",
    kind: "render",
    file: render,
    witness: "cheap-diagnostic",
    edits: [
      [
        "    if !matches!(graph.provenance, Provenance::Edges { .. }) {",
        "    if !matches!(graph.provenance, Provenance::Edges { .. }) {\n        let _ = discover_package_roots(Path::new(&root_absolute.to_lossy()), None);",
      ],
    ],
  },
  {
    name: "human-limit-off-by-one",
    kind: "render",
    file: render,
    witness: "clusters-limit-21",
    edits: [
      ["const HUMAN_LIMIT: usize = 20;", "const HUMAN_LIMIT: usize = 21;"],
    ],
  },
  {
    name: "json-truncated-like-human",
    kind: "render",
    file: render,
    witness: "json-not-human-truncated",
    edits: [
      [
        "stable_stringify(&report, pretty).map(Into::into)",
        "{ let mut report = report; report.clusters.truncate(HUMAN_LIMIT); stable_stringify(&report, pretty).map(Into::into) }",
      ],
    ],
  },
  {
    name: "skipped-limit-off-by-one",
    kind: "render",
    file: render,
    witness: "skipped-many",
    edits: [
      ["const SKIPPED_SHOWN: usize = 5;", "const SKIPPED_SHOWN: usize = 6;"],
    ],
  },
  {
    name: "block-remainder-lost",
    kind: "render",
    file: render,
    witness: "partial-long-block",
    edits: [
      [
        "if twin.shared_block.len() > BLOCK_SHOWN {",
        "if false && twin.shared_block.len() > BLOCK_SHOWN {",
      ],
    ],
  },
  {
    name: "also-members-lost",
    kind: "render",
    file: render,
    witness: "cluster-also",
    edits: [["if !rest.is_empty() {", "if false && !rest.is_empty() {"]],
  },
  {
    name: "callee-units-replaced",
    kind: "render",
    file: render,
    witness: "short.raw-high",
    edits: [
      [
        "let units = callee_id.units();",
        "let encoded = JsString::from(callee_id.to_lossy().as_str()); let units = encoded.units();",
      ],
    ],
  },
  {
    name: "renderer-adds-newline",
    kind: "render",
    file: render,
    witness: "pair-human",
    edits: [
      [
        "Ok(render_human(&report))",
        '{ let mut text = render_human(&report); text.push_str("\\n"); Ok(text) }',
      ],
    ],
  },
  {
    name: "selected-b-offset-replaced-by-prefix",
    kind: "render",
    file: partial,
    witness: "partial-repeated-b-prefix",
    edits: [["calls(self.b)[self.b_start].line", "calls(self.b)[0].line"]],
  },
  {
    name: "by-warning-after-load",
    kind: "cli",
    file: front,
    witness: "warning-before-load-refusal",
    edits: [
      [warning, ""],
      [
        "        assemble_graph_with_analysis_text_and_warning(\n",
        `${warning}        assemble_graph_with_analysis_text_and_warning(\n`,
      ],
    ],
  },
  {
    name: "loader-catch-swallows-assembly",
    kind: "cli",
    file: front,
    witness: "data-catalog-failure",
    edits: [
      [
        `            Err(ClassifiedGraphFailure::LoadRefused(cause)) => {
                return Ok(PlainCollapseDispatch::Refused { cause });
            }
            Err(ClassifiedGraphFailure::Assembly(cause)) => {
                return Err(FrontdoorError::Assembly(cause));
            }`,
        `            Err(ClassifiedGraphFailure::LoadRefused(cause)) => {
                return Ok(PlainCollapseDispatch::Refused { cause });
            }
            Err(ClassifiedGraphFailure::Assembly(cause)) => {
                let _ = cause;
                clean_exit(host, &JsString::from("no tsconfig found"));
                return Ok(PlainCollapseDispatch::Complete);
            }`,
      ],
    ],
  },
  {
    name: "optional-data-omitted",
    kind: "cli",
    file: front,
    witness: "data-in-graph",
    edits: [
      [
        "            data,\n            TextAssembly {",
        "            None,\n            TextAssembly {",
      ],
    ],
  },
  {
    name: "graph-does-not-preempt",
    kind: "cli",
    file: front,
    witness: "headers-graph-priority",
    edits: [
      [
        "let mut payload = if options.graph() == Some(true) {",
        "let mut payload = if false && options.graph() == Some(true) {",
      ],
    ],
  },
  {
    name: "initial-exit-cleared",
    kind: "cli",
    file: front,
    witness: "initial-exit-preserved",
    edits: [
      [
        "        Ok(PlainCollapseDispatch::Complete)",
        "        host.assign_exit(0.0).map_err(FrontdoorError::ExitCode)?;\n        Ok(PlainCollapseDispatch::Complete)",
      ],
    ],
  },
  {
    name: "output-ack-before-write",
    kind: "cli",
    file: io,
    witness: "out-file",
    edits: [
      [ack, ""],
      [
        "        fs::write(destination.to_lossy(), &bytes).map_err(|source| {",
        `${ack}        fs::write(destination.to_lossy(), &bytes).map_err(|source| {`,
      ],
    ],
  },
  {
    name: "pending-warning-erased",
    kind: "cli",
    file: io,
    witness: "warning-stdio-failure",
    edits: [
      [
        "        if let Err(source) = result {",
        "        if let Err(source) = result && stream != StdioStream::Stderr {",
      ],
    ],
  },
];
