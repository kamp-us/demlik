// Frozen shared inputs. Source and native adapters only construct their canonical Graph owners.
const node = (id, { smells = [], chain = 0, ...over } = {}) => ({
  fact: { id, name: id, file: "f.ts", ...over },
  smells,
  chain,
});
const smell = (kind, severity = "warn") => ({
  kind,
  severity,
  value: 2,
  threshold: 1,
});
const call = (calleeId, line = 1) => ({ calleeId, line, constArgs: [] });
export const htmlCases = [
  ["empty-root", { root: "", nodes: [], modules: [] }],
  [
    "cheap-clean",
    {
      root: "pkg",
      nodes: [node("clean", { noEdges: true })],
      modules: [{ file: "f.ts", loc: 20 }],
    },
  ],
  [
    "hierarchy-severity",
    {
      root: "pkg",
      modules: [
        { file: "a/clean.ts", loc: 30 },
        { file: "a/red.ts", loc: 80, smells: [smell("big-file", "high")] },
        { file: "b/warn.ts", loc: 40 },
      ],
      nodes: [
        node("warn", { file: "b/warn.ts", smells: [smell("long-function")] }),
      ],
    },
  ],
  [
    "hub-sites-one-hop",
    {
      root: "pkg",
      modules: [{ file: "f.ts", loc: 60 }],
      nodes: [
        node("hub", {
          callers: ["caller", "caller", "caller"],
          calls: [call("neighbor")],
        }),
        node("caller", {
          calls: [call("hub", 2), call("hub", 3), call("hub", 4)],
        }),
        node("neighbor", { calls: [call("remote")] }),
        node("remote"),
        node("smelly", { smells: [smell("high-complexity", "high")] }),
        node("plain"),
      ],
    },
  ],
  [
    "two-sites-not-hub",
    { root: "pkg", modules: [], nodes: [node("two", { callers: ["a", "b"] })] },
  ],
  [
    "self-sites-hub",
    {
      root: "pkg",
      modules: [],
      nodes: [
        node("self", {
          callers: ["self", "self", "self"],
          calls: [call("self")],
        }),
      ],
    },
  ],
  [
    "cycle-and-unknown",
    {
      root: "pkg",
      modules: [],
      nodes: [
        node("a", {
          smells: [smell("long-function")],
          calls: [call("b"), call("missing")],
        }),
        node("b", { calls: [call("a")] }),
        node("far"),
      ],
    },
  ],
  [
    "duplicate-id-last-node",
    {
      root: "pkg",
      modules: [],
      nodes: [
        node("same", { name: "first", smells: [smell("long-function")] }),
        node("same", { name: "last" }),
      ],
    },
  ],
  [
    "literal-space-edge-key",
    {
      root: "pkg",
      modules: [],
      nodes: [
        node("a b", { smells: [smell("long-function")], calls: [call("c")] }),
        node("a", { smells: [smell("long-function")], calls: [call("b c")] }),
        node("c", { smells: [smell("long-function")] }),
        node("b c", { smells: [smell("long-function")] }),
      ],
    },
  ],
  [
    "directory-before-same-leaf",
    {
      root: "pkg",
      modules: [
        { file: "a", loc: 1 },
        { file: "a/b.ts", loc: 2 },
      ],
      nodes: [],
    },
  ],
  [
    "header-escaping",
    {
      root: 'pkg<&>"😀',
      summary: {
        health: "rotten",
        fileCount: 7,
        functionCount: 8,
        smellCount: 9,
        highSeverityCount: 4,
        worstFile: 'x<&>".ts',
        worstFunction: '<bad>&"',
      },
      modules: [{ file: "odd &.ts", loc: 10 }],
      nodes: [
        node("<id>&", {
          name: "n<&>",
          file: "odd &.ts",
          smells: [smell("high-complexity", "high")],
        }),
      ],
    },
  ],
  ["raw-root-units", { root: "raw\ud800<&", modules: [], nodes: [] }],
  [
    "unicode-directory-order",
    {
      root: "pkg",
      modules: ["\ue000/x.ts", "𐀀/x.ts", "�/x.ts", "é/x.ts", "é/x.ts"].map(
        (file) => ({ file, loc: 1 }),
      ),
      nodes: [],
    },
  ],
  [
    "smell-kinds-dedup",
    {
      root: "pkg",
      modules: [{ file: "f.ts", loc: 30, smells: [smell("big-file")] }],
      nodes: [
        node("kinds", {
          smells: [
            smell("long-function"),
            smell("high-complexity", "high"),
            smell("long-function"),
          ],
        }),
      ],
    },
  ],
];

export function sourceGraph(input, thresholds) {
  const makeSmell = (s, target) => ({
    target,
    value: s.value ?? 2,
    threshold: s.threshold ?? 1,
    severity: s.severity,
    kind: s.kind,
  });
  const functions = input.nodes.map(({ fact: n, smells, chain }) => ({
    id: n.id,
    name: n.name,
    file: n.file,
    kind: n.kind ?? "function",
    startLine: n.startLine ?? 1,
    endLine: n.endLine ?? 10,
    loc: n.loc ?? 10,
    commentLines: 0,
    nestingDepth: n.nestingDepth ?? 1,
    complexity: n.complexity ?? 2,
    isExported: true,
    isTest: n.isTest ?? false,
    edges: n.noEdges
      ? null
      : {
          calls: (n.calls ?? []).map((c) => ({ ...c, declaration: null })),
          calledBy: (n.callers ?? []).map((callerId) => ({
            callerId,
            line: 1,
          })),
          callChainDepth: chain,
        },
    nodeKind: null,
    smells: smells.map((s) =>
      makeSmell(s, {
        type: "function",
        id: n.id,
        file: n.file,
        startLine: n.startLine ?? 1,
      }),
    ),
  }));
  const modules = input.modules.map((m) => ({
    file: m.file,
    loc: m.loc,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: [],
    isTest: false,
    smells: (m.smells ?? []).map((s) =>
      makeSmell(s, { type: "module", file: m.file }),
    ),
  }));
  return {
    root: input.root,
    thresholds,
    provenance: { pass: "cheap" },
    crossRuntime: null,
    reachability: null,
    clusters: null,
    interfaceWidth: null,
    data: null,
    summary: {
      health: "rough",
      fileCount: 0,
      functionCount: 0,
      smellCount: 0,
      highSeverityCount: 0,
      worstFile: null,
      worstFunction: null,
      topTargets: [],
      parseFailures: [],
      ...input.summary,
    },
    functions,
    modules,
    declarations: [],
    directories: [],
    smells: [],
    stats: {
      fileCount: 0,
      functionCount: 0,
      totalLoc: 0,
      totalCommentLines: 0,
      smellCount: 0,
      parseFailures: [],
    },
  };
}
