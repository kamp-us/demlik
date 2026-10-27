const front = "crates/code-graph/src/cli/frontdoor.rs";
export const treeBlastFindFaults = [
  {
    name: "tree-padding-counts-unicode-scalars",
    file: "crates/code-graph/src/render/tree.rs",
    witness: "tree-ansi-unicode-lines",
    contract: "tree names pad to20 UTF16 units",
    edits: [
      [
        "let name = pad_end(&node.name, 20);",
        'let name = format!("{:20}", node.name);',
      ],
    ],
  },
  {
    name: "tree-style-close-not-reopened",
    file: "crates/code-graph/src/render/tree.rs",
    witness: "tree-ansi-unicode-lines",
    contract: "matching raw close is followed by style reopen",
    edits: [
      [
        'let reopened = text.replace(close, &format!("{close}{open}"));',
        "let reopened = text.to_owned();",
      ],
    ],
  },
  {
    name: "tree-json-renders-human-view",
    file: front,
    witness: "tree-json-pretty-headers",
    contract: "tree JSON is the canonical Graph with requested headers",
    scope: [
      "            ConsoleOutput::Tree => {",
      "            ConsoleOutput::File => {",
    ],
    edits: [["if json {", "if false && json {"]],
  },
  {
    name: "blast-transitive-depth-flattened",
    file: "crates/code-graph/src/render/blast.rs",
    witness: "blast-diamond-recursion-package-json",
    contract: "reverse callers preserve shortest transitive depth",
    edits: [["let next = depth + 1;", "let next = 1;"]],
  },
  {
    name: "blast-self-call-included-as-caller",
    file: "crates/code-graph/src/render/blast.rs",
    witness: "blast-diamond-recursion-package-json",
    contract: "self-recursion has its own count and is excluded from callers",
    edits: [
      [
        "if caller.caller_id == target.id {",
        "if false && caller.caller_id == target.id {",
      ],
    ],
  },
  {
    name: "find-site-key-includes-caller",
    file: "crates/code-graph/src/declarations/find.rs",
    witness: "find-shared-function-and-type",
    contract: "two callers on one physical file/line contribute one use",
    edits: [
      [
        'format!("{file}:{}", caller.line),',
        'format!("{file}:{}:{}", caller.line, caller.caller_id),',
      ],
    ],
  },
  {
    name: "find-searches-only-declarations",
    file: "crates/code-graph/src/declarations/find.rs",
    witness: "find-shared-function-and-type",
    contract:
      "one bare name can match both value function and type declaration",
    scope: ["pub fn find_by_name", "    matches.extend("],
    edits: [
      [".filter(|node| name == node.name.as_str())", ".filter(|_| false)"],
    ],
  },
  {
    name: "query-nonzero-exit-lost",
    file: front,
    witness: "blast-ambiguous-no-output-write",
    contract:
      "ambiguous target reports its nonzero decision after warning delivery",
    scope: [
      "        if matches!(output, ConsoleOutput::Blast | ConsoleOutput::Find) {",
      "        let mut payload = match output {",
    ],
    edits: [["if code != 0 {", "if false && code != 0 {"]],
  },
];
