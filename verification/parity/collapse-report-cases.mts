import { z } from "zod";
import { CollapseSettingsSchema } from "../../packages/code-graph/src/collapse/settings.js";
import { FunctionKindSchema } from "../../packages/code-graph/src/schema.js";
export const callSchema = z.strictObject({
  calleeId: z.string(),
  line: z.number().int().nonnegative().default(1),
  constArgs: z.array(z.string()).default([]),
});
export const nodeSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  startLine: z.number().int().nonnegative().default(1),
  endLine: z.number().int().nonnegative().default(10),
  loc: z.number().int().nonnegative().default(10),
  complexity: z.number().int().nonnegative().default(2),
  nestingDepth: z.number().int().nonnegative().default(1),
  kind: FunctionKindSchema.default("function"),
  isTest: z.boolean().default(false),
  noEdges: z.boolean().default(false),
  calls: z.array(callSchema).default([]),
  callers: z.array(z.string()).default([]),
  effect: z.boolean().default(false),
});
export const pureSchema = z.strictObject({
  operation: z.literal("pure"),
  nodes: z.array(nodeSchema),
  packageRoots: z.array(z.string()),
  settings: CollapseSettingsSchema,
});
export type Node = z.infer<typeof nodeSchema>;
export type Pure = z.infer<typeof pureSchema>;
export type Expected = {
  considered?: number;
  pairs?: number;
  candidates?: number;
  clusters?: number;
  partial?: number;
  confidence?: number;
  cost?: number;
  rank?: number;
  signals?: string[];
  members?: number;
  pairCount?: number;
  skipped?: number;
  firstPair?: string[];
};
export type Case = { id: string; input: Pure; expectation?: Expected };
export const call = (calleeId: string, line = 1, constArgs: string[] = []) => ({
  calleeId,
  line,
  constArgs,
});
export function node(
  id: string,
  name = "normalizeMembership",
  over: Partial<Node> = {},
): Node {
  return nodeSchema.parse({
    id,
    name,
    file: id.split(":")[0],
    calls: [call("helpers.ts:normalizeId"), call("helpers.ts:selectRole")],
    ...over,
  });
}
export const two = () => [
  node("a.ts:normalizeMembership"),
  node("b.ts:canonicalMembership", "canonicalMembership"),
];
export const cases: Case[] = [];
function pure(
  id: string,
  nodes = two(),
  settings: Record<string, number> = {},
  packageRoots = [""],
  expectation?: Expected,
) {
  cases.push({
    id,
    input: pureSchema.parse({
      operation: "pure",
      nodes,
      settings,
      packageRoots,
    }),
    expectation,
  });
}
const normal = {
  considered: 2,
  pairs: 1,
  candidates: 1,
  clusters: 1,
  partial: 0,
  confidence: 0.625,
  cost: 1,
  rank: 0.625,
  signals: ["shape", "callees", "name"],
};
pure("membership", undefined, undefined, undefined, normal);
pure(
  "seven-callers",
  [
    node("a.ts:normalizeMembership", "normalizeMembership", {
      callers: Array.from({ length: 7 }, (_, i) => `caller${i}`),
    }),
    two()[1],
  ],
  {},
  [""],
  { ...normal, cost: 4, rank: 0.1563 },
);
pure(
  "effect-path",
  [
    ...two(),
    node("helpers.ts:normalizeId", "normalizeId", {
      loc: 1,
      complexity: 1,
      calls: [],
      effect: true,
    }),
  ],
  {},
  [""],
  { ...normal, cost: 2, rank: 0.3125 },
);
pure(
  "clique",
  [...two(), node("c.ts:projectMembership", "projectMembership")],
  {},
  [""],
  {
    ...normal,
    considered: 3,
    pairs: 3,
    candidates: 3,
    members: 3,
    pairCount: 3,
  },
);
pure(
  "chain",
  [
    node("a.ts:impactBudget", "impactBudget"),
    node("b.ts:impactSeverity", "impactSeverity"),
    node("c.ts:severityBand", "severityBand", {
      calls: [call("helpers.ts:readBand"), call("helpers.ts:selectBand")],
    }),
  ],
  {},
  [""],
  { considered: 3, pairs: 2, candidates: 2, clusters: 2, partial: 0 },
);
pure("empty", [], {}, [], {
  considered: 0,
  pairs: 0,
  candidates: 0,
  clusters: 0,
  partial: 0,
});
pure("single", [two()[0]], {}, [""], {
  considered: 1,
  pairs: 0,
  candidates: 0,
  clusters: 0,
  partial: 0,
});
pure(
  "no-common-block",
  [node("a", "alpha", { calls: [] }), node("b", "omega", { calls: [] })],
  {},
  [""],
  { pairs: 0, candidates: 0 },
);
for (const kind of FunctionKindSchema.options)
  pure(`predicate.kind.${kind}`, [
    node("a", "normalizeMembership", { kind }),
    two()[1],
  ]);
for (const [id, over] of Object.entries({
  test: { isTest: true },
  "no-edges": { noEdges: true },
  short: { loc: 4 },
  "loc-boundary": { loc: 5 },
  branchless: { complexity: 1 },
  "complexity-boundary": { complexity: 2 },
}))
  pure(`predicate.${id}`, [node("a", "normalizeMembership", over), two()[1]]);
for (const [id, over, settings] of [
  ["loc-at-slack", { loc: 13 }, {}],
  ["loc-over-slack", { loc: 14 }, {}],
  ["loc-ratio", { loc: 19 }, { shapeLocRatio: 0.5 }],
  ["cx-at-slack", { complexity: 3 }, {}],
  ["cx-over-slack", { complexity: 4 }, {}],
  ["nest-at-slack", { nestingDepth: 2 }, {}],
  ["nest-over-slack", { nestingDepth: 3 }, {}],
  ["no-slack", { loc: 11 }, { shapeLocSlack: 0, shapeLocRatio: 0 }],
  [
    "zero-tolerance",
    {},
    {
      shapeLocSlack: 0,
      shapeLocRatio: 0,
      shapeComplexitySlack: 0,
      shapeNestingSlack: 0,
    },
  ],
] as const)
  pure(
    `shape.${id}`,
    [two()[0], node("b", "canonicalMembership", over)],
    settings,
  );
for (const minSignals of [2, 3, 4])
  pure(`signals.minimum-${minSignals}`, undefined, { minSignals });
pure(
  "signals.all-four",
  [
    node("a", "normalizeMembership", { callers: ["x", "y"] }),
    node("b", "canonicalMembership", { callers: ["y", "x"] }),
  ],
  {},
  [""],
  {
    confidence: 0.875,
    cost: 2.585,
    rank: 0.3385,
    signals: ["shape", "callees", "callers", "name"],
  },
);
pure(
  "signals.duplicate-callees",
  [
    node("a", "normalizeMembership", { calls: [call("x"), call("x")] }),
    node("b", "canonicalMembership", { calls: [call("x"), call("x")] }),
  ],
  {},
  [""],
  { signals: ["shape", "name"], confidence: 0.375 },
);
pure("signals.duplicate-callers", [
  node("a", "normalizeMembership", { callers: ["x", "x"] }),
  node("b", "canonicalMembership", { callers: ["x", "x"] }),
]);
pure(
  "signals.caller-block-only",
  [
    node("a", "alpha", { calls: [], callers: ["x", "y"] }),
    node("b", "omega", { calls: [], callers: ["x", "y"] }),
  ],
  {},
  [""],
  { pairs: 1, signals: ["shape", "callers"], confidence: 0.5 },
);
for (const threshold of [0.49, 0.5, 0.50001, 1])
  pure(
    `signals.callee-threshold-${threshold}`,
    [
      node("a", "alpha", { calls: [call("x"), call("y")] }),
      node("b", "omega", {
        calls: [call("x"), call("y"), call("z"), call("q")],
      }),
    ],
    { calleeJaccard: threshold },
  );
pure(
  "signals.empty-sets",
  [
    node("a", "normalizeMembership", { calls: [] }),
    node("b", "canonicalMembership", { calls: [] }),
  ],
  { minSetSize: 0, calleeJaccard: 0, callerJaccard: 0 },
);
for (const [a, b] of [
  ["HTTPRequestHandlers", "XMLRequestHandler"],
  ["membership2Rules", "membership2Rule"],
  ["normalizations", "normalize"],
  ["stabilizers", "stabilized"],
  ["reprocessing", "processing"],
  ["countings", "counting"],
  ["creates", "create"],
  ["idKeyBuild", "loadName"],
  ["aa", "AA"],
  ["go", "to"],
  ["μMemberΔRole", "MemberRole"],
  ["Z2HTTPRequest", "Y2Request"],
  ["userMembership", "Membership"],
  ["BUILD__MEMBERSHIPS", "createMembership"],
  ["summary", "summaries"],
  ["weights", "weight"],
])
  pure(`tokens.${a}.${b}`, [
    node("a", a, { calls: [] }),
    node("b", b, { calls: [] }),
  ]);
for (const nameMinTokenLength of [0, 3, 4, 5, 30])
  pure(`tokens.length-${nameMinTokenLength}`, undefined, {
    nameMinTokenLength,
  });
for (const nameOverlap of [0, 0.5, 0.50001, 1])
  pure(`tokens.overlap-${nameOverlap}`, undefined, { nameOverlap });
for (const maxBlockSize of [0, 1, 2, 3])
  pure(
    `blocks.limit-${maxBlockSize}`,
    [...two(), node("c", "projectMembership")],
    { maxBlockSize },
  );
pure(
  "blocks.sort-kinds",
  [
    ...two().map((n) => ({ ...n, callers: ["bigger", "minor"] })),
    node("c", "projectMembership", { callers: ["bigger"] }),
  ],
  { maxBlockSize: 1 },
);
pure(
  "blocks.raw-callee-unit",
  [
    ...two().map((n) => ({
      ...n,
      calls: [call("raw\ud800"), call("raw\udc00")],
    })),
  ],
  { maxBlockSize: 1 },
);
const partialNodes = () => [
  node("a", "normalizeMembership", {
    calls: ["p", "q", "r", "left"].map((id, i) =>
      call(id, 10 + i, i === 1 ? ["LIMIT"] : []),
    ),
  }),
  node("b", "canonicalMembership", {
    calls: ["p", "q", "r", "right"].map((id, i) =>
      call(id, 20 + i, i === 1 ? ["LIMIT"] : []),
    ),
  }),
];
pure("partial.independent-blocks", partialNodes(), { maxBlockSize: 0 }, [""], {
  candidates: 0,
  partial: 1,
});
pure("partial.independent-score", partialNodes(), { minSignals: 4 }, [""], {
  candidates: 0,
  partial: 1,
});
pure("partial.normal", partialNodes(), {}, [""], { partial: 1 });
pure("partial.block-cap", partialNodes(), { partialMaxBlockSize: 1 }, [""], {
  partial: 0,
});
pure("effects.transitive", [
  ...two(),
  node("helpers.ts:normalizeId", "normalizeId", {
    loc: 1,
    complexity: 1,
    calls: [call("terminal")],
  }),
  node("terminal", "terminal", {
    loc: 1,
    complexity: 1,
    calls: [],
    effect: true,
  }),
]);
pure(
  "effects.reverse-not-forward",
  [
    ...two(),
    node("terminal", "terminal", {
      loc: 1,
      complexity: 1,
      calls: [call(two()[0].id)],
      effect: true,
    }),
  ],
  {},
  [""],
  { cost: 1 },
);
pure("effects.cycle", [
  ...two(),
  node("helpers.ts:normalizeId", "normalizeId", {
    loc: 1,
    complexity: 1,
    calls: [call("terminal")],
  }),
  node("terminal", "terminal", {
    loc: 1,
    complexity: 1,
    calls: [call("helpers.ts:normalizeId")],
    effect: true,
  }),
]);
pure(
  "effects.external-not-a-seed",
  two().map((n) => ({ ...n, calls: [...n.calls, call("external:fetch")] })),
  {},
  [""],
  { cost: 1 },
);
pure(
  "packages.cross",
  [
    node("a", "normalizeMembership", { file: "packages/a/a.ts" }),
    node("b", "canonicalMembership", { file: "packages/b/b.ts" }),
  ],
  {},
  ["packages/a", "packages/b", ""],
  { cost: 4 },
);
pure(
  "packages.longest-root",
  [
    node("a", "normalizeMembership", { file: "packages/a/nested/a.ts" }),
    node("b", "canonicalMembership", { file: "packages/a/b.ts" }),
  ],
  {},
  ["packages/a", "", "packages/a/nested"],
  { cost: 4 },
);
pure(
  "packages.slash-boundary",
  [
    node("a", "normalizeMembership", { file: "packages/aa/a.ts" }),
    node("b", "canonicalMembership", { file: "b.ts" }),
  ],
  {},
  ["packages/a", ""],
  { cost: 1 },
);
pure(
  "packages.caller-context",
  [
    node("a", "normalizeMembership", { callers: ["caller"] }),
    two()[1],
    node("caller", "caller", {
      file: "other/x.ts",
      loc: 1,
      complexity: 1,
      calls: [],
    }),
  ],
  {},
  ["other", ""],
  { cost: 3 },
);
pure(
  "packages.last-file-wins",
  [
    node("a", "normalizeMembership", { callers: ["caller"] }),
    two()[1],
    node("caller", "caller", {
      file: "other/x.ts",
      loc: 1,
      complexity: 1,
      calls: [],
    }),
    node("caller", "caller", {
      file: "same/x.ts",
      loc: 1,
      complexity: 1,
      calls: [],
    }),
  ],
  {},
  ["other", ""],
  { cost: 2 },
);
pure("packages.equal-length-order", undefined, {}, ["b", "a", ""]);
pure("order.reversed-input", two().reverse(), {}, [""], normal);
pure("order.locale", [
  node("Z", "normalizeMembership"),
  node("ä", "canonicalMembership"),
  node("a", "projectMembership"),
  node("A", "impactMembership"),
]);
pure("order.equal-identifiers", [
  node("same", "normalizeMembership"),
  node("same", "canonicalMembership"),
  node("c", "projectMembership"),
]);
pure("order.nul-collision", [
  node("a", "normalizeMembership"),
  node("b\0c", "canonicalMembership"),
  node("a\0b", "impactMembership"),
  node("c", "projectMembership"),
]);
pure(
  "cost.std-log2-boundary",
  [
    node("a", "normalizeMembership", {
      callers: Array.from({ length: 1374 }, (_, i) => `caller${i}`),
    }),
    two()[1],
  ],
  { costCallerWeight: 0.04796543348725695 },
  [""],
  { cost: 1.5001 },
);
for (const weight of [0, -0, Number.MAX_VALUE])
  pure(
    `cost.caller-weight-${Object.is(weight, -0) ? "minus-zero" : weight}`,
    [node("a", "normalizeMembership", { callers: ["x", "y", "z"] }), two()[1]],
    { costCallerWeight: weight },
  );
pure(
  "cost.overflow-sum",
  [
    node("a", "normalizeMembership", { file: "p/a.ts", callers: ["x"] }),
    node("b", "canonicalMembership", { file: "q/b.ts", effect: true }),
  ],
  {
    costCallerWeight: Number.MAX_VALUE,
    costPackageWeight: Number.MAX_VALUE,
    costCrossPackageWeight: Number.MAX_VALUE,
    costEffectWeight: Number.MAX_VALUE,
  },
  ["p", "q"],
);
pure("shape.extreme-ratio", undefined, { shapeLocRatio: Number.MAX_VALUE });
