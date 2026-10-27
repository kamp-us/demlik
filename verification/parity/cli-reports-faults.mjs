const front = "crates/code-graph/src/cli/frontdoor.rs",
  analysis = "crates/code-graph/src/render/analysis.rs",
  coupling = "crates/code-graph/src/smells/coupling.rs";
const late = ["    pub fn dispatch_reports_blocking(", null];
export const cliReportsFaults = [
  {
    name: "default-renders-whole-graph",
    file: "crates/code-graph/src/render/summary.rs",
    witness: "default-cheap-no-compiler",
    contract: "default stdout is summary JSON",
    edits: [
      [
        "stable_stringify(&graph.summary, pretty)",
        "stable_stringify(graph, pretty)",
      ],
    ],
  },
  {
    name: "ordinary-ci-validates-output-destination",
    file: front,
    scope: late,
    witness: "ci-ignores-output-destination",
    contract: "ordinary CI writes stdout directly and ignores --out",
    edits: [
      [
        "            let code = ci::run_smell_gate",
        "            output_to(options.out()).emit(host, &JsString::default()).map_err(FrontdoorError::ReportEmit)?;\n            let code = ci::run_smell_gate",
      ],
    ],
  },
  {
    name: "ci-empty-max-accepted",
    file: "crates/code-graph/src/render/ci.rs",
    witness: "ci-empty-max",
    contract: "empty max refuses2",
    edits: [["if trimmed.is_empty()", "if false && trimmed.is_empty()"]],
  },
  {
    name: "ci-infinite-decimal-clamped",
    file: "crates/code-graph/src/render/ci.rs",
    witness: "ci-max-infinity",
    contract: "Source-valid huge decimal remains Infinity",
    edits: [
      [
        "trimmed.to_lossy().parse::<f64>().unwrap_or(f64::INFINITY)",
        "trimmed.to_lossy().parse::<f64>().ok().filter(|value| value.is_finite()).unwrap_or(0.0)",
      ],
    ],
  },
  {
    name: "ci-policy-warning-lost",
    file: "crates/code-graph/src/render/ci.rs",
    witness: "ci-unknown-policy-before-invalid-max",
    contract: "unknown fail-on warning precedes max refusal",
    edits: [
      [
        "                host.write_stderr(&line);\n                FailOn::High",
        "                FailOn::High",
      ],
    ],
  },
  {
    name: "impact-plan-uses-cheap-graph",
    file: front,
    scope: late,
    witness: "plan-impact-needs-edges",
    contract: "impact refuses2 after cheap assembly",
    edits: [
      [
        "if matches!(axis, PlanAxis::Impact)",
        "if false && matches!(axis, PlanAxis::Impact)",
      ],
    ],
  },
  {
    name: "plan-fallback-warning-lost",
    file: front,
    scope: late,
    witness: "plan-unknown-axis",
    contract: "winning invalid plan axis warns and falls back",
    edits: [
      [
        "                        host.write_stderr(&warning);\n                        PlanAxis::Rot",
        "                        PlanAxis::Rot",
      ],
    ],
  },
  {
    name: "two-member-cycle-omitted",
    file: coupling,
    witness: "cycles-text",
    contract: "SCC of two modules is a dependency cycle",
    edits: [
      [
        ".filter(|members| members.len() >= 2)",
        ".filter(|members| members.len() >= 3)",
      ],
    ],
  },
  {
    name: "cross-package-group-omitted",
    file: coupling,
    witness: "smells-real-coupling",
    contract: "human coupling includes actual cross-package value edges",
    edits: [["        if from == to {", "        if true || from == to {"]],
  },
  {
    name: "coupling-rank-tie-reversed",
    file: coupling,
    witness: "smells-real-coupling",
    contract: "equal coupling scores retain Source file ordering",
    edits: [
      ["locale_compare(&a.file, &b.file)", "locale_compare(&b.file, &a.file)"],
    ],
  },
  {
    name: "cross-runtime-json-loses-envelope",
    file: analysis,
    scope: ["pub fn render_cross_runtime(", "pub fn render_unguarded("],
    witness: "cross-runtime-json",
    contract: "JSON carries report census/configs and edges",
    edits: [
      [
        "stable_stringify(report, pretty)",
        "stable_stringify(&report.edges, pretty)",
      ],
    ],
  },
  {
    name: "kinds-json-returns-functions",
    file: analysis,
    witness: "kinds-json",
    contract: "kinds JSON is the actual kind census",
    edits: [
      [
        "stable_stringify(&census, pretty)",
        "stable_stringify(&graph.functions, pretty)",
      ],
    ],
  },
  {
    name: "clusters-display-isolated-as-clustered",
    file: analysis,
    witness: "clusters-text",
    contract: "cluster headline counts clustered files",
    edits: [
      [
        "number(report.clustered_file_count as f64)",
        "number(report.isolated_file_count as f64)",
      ],
    ],
  },
  {
    name: "zero-consumer-export-lines-omitted",
    file: analysis,
    witness: "interface-width-text",
    contract: "human width lists actual zero-consumer exports",
    edits: [
      [
        ".filter(|row| row.external_consumers.is_empty())",
        ".filter(|row| !row.external_consumers.is_empty())",
      ],
    ],
  },
  {
    name: "unattributed-data-sites-hidden",
    file: "crates/code-graph/src/data/render.rs",
    witness: "data-text-cheap",
    contract: "top-level binding access remains observable",
    edits: [
      [
        "for site in &report.unattributed {",
        "for site in report.unattributed.iter().take(0) {",
      ],
    ],
  },
  {
    name: "file-literal-fallback-lost",
    file: "crates/code-graph/src/render/file.rs",
    witness: "file-literal-fallback",
    contract: "file view matches literal target after cwd-relative projection",
    edits: [["wanted == file || target == file", "wanted == file"]],
  },
  {
    name: "file-parse-failure-misreported-missing",
    file: "crates/code-graph/src/render/file.rs",
    witness: "file-parse-failure-warning",
    contract: "parse failure has its own warning",
    edits: [[".any(|file| matches(file))", ".any(|_file| false)"]],
  },
  {
    name: "console-final-line-feed-lost",
    file: front,
    scope: late,
    witness: "default-cheap-no-compiler",
    contract: "late report emits one final LF",
    edits: [['        payload.push_str("\\n");\n', ""]],
  },
].map((f) => ({ ...f, kind: "reports" }));
