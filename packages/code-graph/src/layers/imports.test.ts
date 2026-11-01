import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runLayerGate } from "./gate.js";
import type { AllowedEdge } from "./rules.js";

const sources: Readonly<Record<string, string>> = {
  "src/app/process.ts": [
    'import { queue } from "../coordination/queue.js";',
    'import { rule } from "../domain/rule.js";',
    'import { view } from "./view.js";',
    "export const process = [queue, rule, view];",
    "",
  ].join("\n"),
  "src/app/view.ts": [
    'import { queue } from "../coordination/queue.js";',
    'import type { Store } from "../data/store.js";',
    "export const view: Store | typeof queue = queue;",
    "",
  ].join("\n"),
  "src/coordination/queue.ts": [
    'import { rule } from "../domain/rule.js";',
    'import { store } from "../data/store.js";',
    "export const queue = [rule, store];",
    "",
  ].join("\n"),
  "src/domain/rule.ts": [
    'import { store } from "../data/store.js";',
    "export const rule = store;",
    "",
  ].join("\n"),
  "src/data/store.ts": "export type Store = unknown;\nexport const store = 1;\n",
  "src/data/leak.ts":
    'import { process } from "../app/process.js";\nexport const leak = process;\n',
  "src/tools/script.ts": [
    'import fs from "node:fs";',
    'import { missing } from "./missing.js";',
    'import { store } from "../data/store.js";',
    "export const script = [fs, missing, store];",
    "",
  ].join("\n"),
};

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cg-layer-imports-"));
afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));
for (const [file, source] of Object.entries(sources)) {
  fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
  fs.writeFileSync(path.join(fixture, file), source);
}

const NAMES = ["app", "coordination", "domain", "data"] as const;
type LayerName = (typeof NAMES)[number];

function stack(imports: Partial<Record<LayerName, readonly string[]>>): unknown[] {
  return NAMES.map((name) => ({
    name,
    paths: [`src/${name}`],
    ...(imports[name] === undefined ? {} : { imports: imports[name] }),
  }));
}

const STRICT = stack({
  app: ["coordination"],
  coordination: ["domain"],
  domain: ["data"],
  data: [],
});

let rulesFiles = 0;

function gate(layers: unknown[], allowed: readonly AllowedEdge[], json: boolean) {
  const file = path.join(fixture, `rules-${rulesFiles++}.json`);
  fs.writeFileSync(file, JSON.stringify({ layers, allowed }));
  const out: string[] = [];
  const refusals: string[] = [];
  const code = runLayerGate({
    rootAbsolute: fixture,
    repoRoot: fixture,
    layerRulesFile: file,
    emit: (payload) => out.push(payload),
    report: (message) => refusals.push(message),
    json,
    pretty: false,
  });
  return { code, stdout: out.join(""), refusals };
}

type WireEdge = {
  readonly from: string;
  readonly fromLine: number;
  readonly fromLayer: string;
  readonly toLayer: string;
  readonly rule: string;
};

function broken(stdout: string): string[] {
  const { violations } = JSON.parse(stdout) as { violations: WireEdge[] };
  return violations.map(
    (edge) => `${edge.from}:${edge.fromLine} ${edge.fromLayer} -> ${edge.toLayer} [${edge.rule}]`,
  );
}

const STRICT_BREAKS = [
  "src/app/process.ts:2 app -> domain [outside-imports]",
  "src/app/view.ts:2 app -> data [outside-imports]",
  "src/coordination/queue.ts:2 coordination -> data [outside-imports]",
  "src/data/leak.ts:1 data -> app [upward]",
];

describe("a strict stack fails an import that skips a layer", () => {
  it("fails every skip and the planted upward import, and passes every edge to the next layer", () => {
    const text = gate(STRICT, [], false);
    const json = gate(STRICT, [], true);

    expect(text.code).toBe(1);
    expect(json.code).toBe(1);
    expect(broken(json.stdout)).toEqual(STRICT_BREAKS);
    expect(text.stdout).toContain(
      'src/coordination/queue.ts:2  coordination -> data  src/data/store.ts:1  ("../data/store.js")  [outside-imports]',
    );
    expect(text.stdout).toContain(
      'src/app/view.ts:2  app -> data  src/data/store.ts:1  ("../data/store.js")  [outside-imports]  [type-only]',
    );
    expect(text.stdout).toContain(
      'src/data/leak.ts:1  data -> app  src/app/process.ts:1  ("../app/process.js")  [upward]',
    );
    expect(text.stdout).not.toContain("points UP");
    expect(text.stdout).not.toContain("upward import sites");
  });

  it("answers the same on a second run", () => {
    expect(gate(STRICT, [], false)).toEqual(gate(STRICT, [], false));
    expect(gate(STRICT, [], true)).toEqual(gate(STRICT, [], true));
  });

  it("judges only the layers that declare `imports`", () => {
    const { code, stdout } = gate(stack({ coordination: ["domain"] }), [], true);
    expect(code).toBe(1);
    expect(broken(stdout)).toEqual([
      "src/coordination/queue.ts:2 coordination -> data [outside-imports]",
      "src/data/leak.ts:1 data -> app [upward]",
    ]);
  });

  it("lets `imports: []` import only itself, and passes inside a layer whatever the list says", () => {
    const { stdout } = gate(stack({ app: [] }), [], true);
    expect(broken(stdout)).toEqual([
      "src/app/process.ts:1 app -> coordination [outside-imports]",
      "src/app/process.ts:2 app -> domain [outside-imports]",
      "src/app/view.ts:1 app -> coordination [outside-imports]",
      "src/app/view.ts:2 app -> data [outside-imports]",
      "src/data/leak.ts:1 data -> app [upward]",
    ]);
  });

  it("counts external, unlayered and unresolved imports with no verdict", () => {
    const parsed = JSON.parse(gate(STRICT, [], true).stdout) as {
      census: Record<string, number>;
      unresolved: string[];
    };
    expect(parsed.census).toEqual({
      down: 7,
      sideways: 1,
      up: 1,
      unlayered: 1,
      external: 1,
      unresolved: 1,
    });
    expect(parsed.unresolved).toEqual(["src/tools/script.ts:2 ./missing.js"]);
  });
});

describe("`allowed` excuses an edge outside the list as it excuses an upward one", () => {
  const SKIP = { from: "src/coordination/queue.ts", to: "src/data/store.ts" };
  const upwardAndOtherSkips: AllowedEdge[] = [
    { from: "src/app/process.ts", to: "src/domain/rule.ts", sites: 1, reason: "r" },
    { from: "src/app/view.ts", to: "src/data/store.ts", sites: 1, reason: "r" },
    { from: "src/data/leak.ts", to: "src/app/process.ts", sites: 1, reason: "r" },
  ];

  it("passes when every breaking edge is declared with its exact count", () => {
    const { code, stdout } = gate(
      STRICT,
      [...upwardAndOtherSkips, { ...SKIP, sites: 1, reason: "r" }],
      true,
    );
    expect(code).toBe(0);
    expect(broken(stdout)).toEqual(STRICT_BREAKS);
  });

  it("fails on a wrong site count", () => {
    const { code, stdout } = gate(
      STRICT,
      [...upwardAndOtherSkips, { ...SKIP, sites: 2, reason: "r" }],
      true,
    );
    expect(code).toBe(1);
    const { miscounted } = JSON.parse(stdout) as { miscounted: { actual: number }[] };
    expect(miscounted.map((m) => m.actual)).toEqual([1]);
  });

  it("fails on an entry whose edge is on the list, so it excuses nothing", () => {
    const onTheList = { from: "src/app/process.ts", to: "src/coordination/queue.ts" };
    const { code, stdout } = gate(
      STRICT,
      [
        ...upwardAndOtherSkips,
        { ...SKIP, sites: 1, reason: "r" },
        { ...onTheList, sites: 1, reason: "r" },
      ],
      true,
    );
    expect(code).toBe(1);
    const { stale } = JSON.parse(stdout) as { stale: { to: string }[] };
    expect(stale.map((e) => e.to)).toEqual([onTheList.to]);
  });

  it("still lists an undeclared one", () => {
    const { code, stdout } = gate(STRICT, upwardAndOtherSkips, true);
    expect(code).toBe(1);
    const { undeclared } = JSON.parse(stdout) as { undeclared: WireEdge[] };
    expect(undeclared.map((e) => e.from)).toEqual([SKIP.from]);
  });
});

describe("a rules file whose `imports` cannot mean anything is refused on load", () => {
  it.each([
    {
      name: "an unknown layer",
      layers: stack({ app: ["nope"] }),
      refusal: 'layer "app" imports "nope", which is not a declared layer.',
    },
    {
      name: "a layer above",
      layers: stack({ data: ["app"] }),
      refusal:
        'layer "data" imports "app", which is above it; `imports` cannot grant an upward edge.',
    },
  ])("exits 2 with one line naming both for $name", ({ layers, refusal }) => {
    const { code, stdout, refusals } = gate(layers, [], false);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(refusals).toEqual([refusal]);
  });
});

describe("a rules file with no `imports` anywhere keeps its exact output", () => {
  it("prints the same text and exit code as before `imports` existed", () => {
    const { code, stdout } = gate(stack({}), [], false);
    expect(code).toBe(1);
    expect(stdout).toMatchInlineSnapshot(`
      "layers: app > coordination > domain > data
      scanned 7 files — 7 down, 1 sideways, 1 UP, 1 unlayered, 1 external, 1 unresolved
        UNRESOLVED  src/tools/script.ts:2 ./missing.js
      violations (1 upward import sites):
        src/data/leak.ts:1  data -> app  src/app/process.ts:1  ("../app/process.js")
      LAYER GATE FAILED.
        1 undeclared violation(s) — an edge points UP the stack:
        src/data/leak.ts:1  data -> app  src/app/process.ts:1  ("../app/process.js")
        Fix: point the dependency down (move the shared thing into a lower layer, or
        invert it behind a contract). If it cannot move in this PR, add the pair to the
        \`allowed\` array in your --layer-rules file with its exact site count and a reason.
      "
    `);
  });

  it("prints the same --json as before `imports` existed", () => {
    const { code, stdout } = gate(stack({}), [], true);
    expect(code).toBe(1);
    expect(stdout).toMatchInlineSnapshot(`
      "{"census":{"down":7,"external":1,"sideways":1,"unlayered":1,"unresolved":1,"up":1},"filesScanned":7,"layers":["app","coordination","domain","data"],"miscounted":[],"passed":false,"stale":[],"undeclared":[{"from":"src/data/leak.ts","fromLayer":"data","fromLine":1,"specifier":"../app/process.js","to":"src/app/process.ts","toLayer":"app","toLine":1,"typeOnly":false}],"unresolved":["src/tools/script.ts:2 ./missing.js"],"violations":[{"from":"src/data/leak.ts","fromLayer":"data","fromLine":1,"specifier":"../app/process.js","to":"src/app/process.ts","toLayer":"app","toLine":1,"typeOnly":false}]}
      "
    `);
  });
});
