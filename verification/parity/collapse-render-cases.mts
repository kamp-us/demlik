import { call, type Node, node, two } from "./collapse-report-cases.mjs";
export type RenderCase = {
  id: string;
  nodes: Node[];
  settings?: Record<string, number>;
  edges?: boolean;
  json?: boolean;
  pretty?: boolean;
  packages?: string[];
  expectedB?: number[];
};
export const renderCases: RenderCase[] = [
  { id: "cheap-diagnostic", nodes: [], edges: false },
  { id: "empty-human", nodes: [] },
  { id: "pair-human", nodes: two() },
  { id: "pair-json", nodes: two(), json: true },
  { id: "pair-pretty-json", nodes: two(), json: true, pretty: true },
  { id: "pair-pretty-ignored-human", nodes: two(), pretty: true },
  {
    id: "cluster-also",
    nodes: [...two(), node("c:projectMembership", "projectMembership")],
  },
  {
    id: "cost-flags",
    nodes: [
      node("a", "normalizeMembership", {
        file: "packages/a/a.ts",
        callers: [
          "caller0",
          "caller1",
          "caller2",
          "caller3",
          "caller4",
          "caller5",
          "caller6",
        ],
      }),
      node("b", "canonicalMembership", { file: "packages/b/b.ts" }),
      node("helpers.ts:normalizeId", "normalizeId", {
        calls: [],
        loc: 1,
        complexity: 1,
        effect: true,
      }),
    ],
    packages: ["packages/a", "packages/b"],
  },
  {
    id: "human-infinity",
    nodes: [
      node("a", "normalizeMembership", { callers: ["a1", "a2", "a3"] }),
      two()[1],
    ],
    settings: { costCallerWeight: Number.MAX_VALUE },
  },
  {
    id: "json-infinity-null",
    nodes: [
      node("a", "normalizeMembership", { callers: ["a1", "a2", "a3"] }),
      two()[1],
    ],
    settings: { costCallerWeight: Number.MAX_VALUE },
    json: true,
  },
  {
    id: "no-score-still-partial",
    nodes: partial(),
    settings: { minSignals: 4 },
  },
  { id: "partial-four-callees", nodes: partial(4) },
  { id: "partial-five-callees", nodes: partial(5) },
  { id: "partial-long-block", nodes: partial(7) },
  {
    id: "partial-repeated-b-prefix",
    nodes: [
      node("a", "normalizeMembership", {
        calls: [
          call("p", 10),
          call("q", 11, ["LIMIT"]),
          call("r", 12),
          call("left", 13),
        ],
      }),
      node("b", "canonicalMembership", {
        calls: [
          call("p", 100),
          call("q", 101, ["LIMIT"]),
          call("r", 102),
          call("left", 103),
          call("p", 104),
          call("q", 105, ["LIMIT"]),
          call("r", 106),
          call("right", 107),
        ],
      }),
    ],
    expectedB: [104],
  },
  {
    id: "skipped-many",
    nodes: two().map((n) => ({
      ...n,
      calls: ["raw0", "raw1", "raw2", "raw3", "raw4", "raw5"].map((id) =>
        call(id),
      ),
    })),
    settings: { maxBlockSize: 0 },
  },
  {
    id: "skipped-raw-units",
    nodes: two().map((n) => ({
      ...n,
      calls: [call("raw\ud800"), call("raw\udc00")],
    })),
    settings: { maxBlockSize: 0 },
  },
  {
    id: "partial-raw-callee",
    nodes: [
      node("a", "normalizeMembership", {
        calls: [
          call("external:lib:raw\ud800", 10),
          call("q", 11, ["LIMIT"]),
          call("r", 12),
          call("external:api:left\udc00", 13),
        ],
      }),
      node("b", "canonicalMembership", {
        calls: [
          call("external:lib:raw\ud800", 100),
          call("q", 101, ["LIMIT"]),
          call("r", 102),
          call("external:api:right\udfff", 103),
        ],
      }),
    ],
  },
];
function partial(width = 3): Node[] {
  return ["left", "right"].map((outcome, i) =>
    node(i ? "b" : "a", i ? "canonicalMembership" : "normalizeMembership", {
      calls: [
        ...Array.from({ length: width }, (_, j) =>
          call(`external:shared:step${j}`, 20 + j, j === 1 ? ["LIMIT"] : []),
        ),
        call(outcome, 20 + width),
      ],
    }),
  );
}
function groups(count: number, partials: boolean): Node[] {
  return Array.from({ length: count }, (_, i) => [
    node(`a${i}`, `normalizeCohort${i}`, {
      calls: (partials ? ["p", "q", "r", "left"] : ["p", "q"]).map((v, j) =>
        call(v + i, 10 + j, partials && j === 1 ? [`LIMIT_${i}`] : []),
      ),
    }),
    node(`b${i}`, `canonicalCohort${i}`, {
      calls: (partials ? ["p", "q", "r", "right"] : ["p", "q"]).map((v, j) =>
        call(v + i, 20 + j, partials && j === 1 ? [`LIMIT_${i}`] : []),
      ),
    }),
  ]).flat();
}
for (const count of [20, 21]) {
  renderCases.push({
    id: `clusters-limit-${count}`,
    nodes: groups(count, false),
    settings: { minSignals: 3 },
  });
  renderCases.push({
    id: `partials-limit-${count}`,
    nodes: groups(count, true),
    settings: { minSignals: 4 },
  });
}
renderCases.push({
  id: "json-not-human-truncated",
  nodes: groups(21, false),
  settings: { minSignals: 3 },
  json: true,
});
export const shortCases = [
  ["empty", ""],
  ["plain", "run"],
  ["external", "external:mod:run"],
  ["colon", "x:run"],
  ["several-colons", "a:b:c"],
  ["empty-suffix", "external:"],
  ["colon-only", ":"],
  ["embedded-external", "prefix:external:run"],
  ["uppercase-prefix", "EXTERNAL:run"],
  ["astral", "external:mod:𐀀"],
  ["raw-high", "external:m:\ud800"],
  ["raw-low", "m:\udfff"],
  ["raw-before-colon", "\ud800:ok"],
].map(([id, value]) => ({ id: `short.${id}`, value }));
