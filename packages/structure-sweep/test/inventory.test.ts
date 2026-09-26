import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupsFileOf, writeGroupsFile } from "../src/groups/file.js";
import {
  buildInventory,
  type InventoryEntry,
  type InventoryInputs,
  topLevelScope,
} from "../src/inventory/build.js";
import { INVENTORY_USAGE, inventoryCommand } from "../src/inventory/cli.js";
import { globMatcher } from "../src/inventory/glob.js";
import type {
  ConsolidateInput,
  GraphInput,
  PairInput,
  Source,
  UnreachableInput,
} from "../src/inventory/inputs.js";
import { memoryArtifactStore, runStage } from "../src/lowering/artifact.js";
import {
  askGroupVerdict,
  type ClusterRecord,
  confirmInput,
  confirmStage,
} from "../src/lowering/group.js";
import type { PairVerdict } from "../src/pairs/questions.js";
import { repo, write } from "./helpers.js";
import {
  clustersOf,
  groupAnswer,
  SHAPE_A,
  stage6Policy,
  stubGroupJev,
} from "./lowering-group-fixture.js";

// Every file, function and verdict below is synthetic, written for these tests.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const read = <T>(path: string, value: T): Source<T> => ({
  _tag: "read",
  path,
  value,
});

const missing = <T>(flag: string, path: string | null = null): Source<T> => ({
  _tag: "missing",
  flag,
  path,
});

const fn = (
  file: string,
  name: string,
  startLine: number,
  endLine: number,
  extra: { isExported?: boolean; isTest?: boolean } = {},
) => ({
  id: `${file}:${name}`,
  name,
  file,
  startLine,
  endLine,
  isExported: extra.isExported ?? true,
  isTest: extra.isTest ?? false,
});

const GRAPH: GraphInput = {
  functions: [
    fn("packages/a/src/money.ts", "formatMoney", 1, 10),
    fn("packages/b/src/cash.ts", "formatMoney", 4, 9),
    fn("packages/a/src/x.ts", "sameScope", 1, 3),
    fn("packages/a/lib/y.ts", "sameScope", 1, 3),
    fn("packages/a/src/r.ts", "get", 1, 3),
    fn("packages/b/src/r.ts", "get", 1, 3),
    fn("packages/a/src/p.ts", "privateTwin", 1, 3, { isExported: false }),
    fn("packages/b/src/p.ts", "privateTwin", 1, 3, { isExported: false }),
    fn("packages/a/src/old.ts", "unusedLong", 5, 24),
    fn("packages/a/src/old.ts", "onlyTested", 30, 33),
  ],
};

const UNREACHABLE: UnreachableInput = {
  unreachable: [
    {
      id: "packages/a/src/old.ts:onlyTested",
      file: "packages/a/src/old.ts",
      startLine: 30,
      category: "only-called-from-tests",
      testReferences: ["packages/a/test/old.test.ts"],
    },
    {
      id: "packages/a/src/old.ts:unusedLong",
      file: "packages/a/src/old.ts",
      startLine: 5,
      category: "dead",
      testReferences: [],
    },
  ],
  functions: [],
};

const CONSOLIDATE: ConsolidateInput = {
  ref: "HEAD",
  minCluster: 3,
  merge: [
    {
      scope: "packages/design",
      feature: "ui",
      role: "component",
      files: [
        { path: "packages/design/src/a.ts", lines: 4 },
        { path: "packages/design/src/b.ts", lines: 4 },
        { path: "packages/design/src/c.ts", lines: 4 },
      ],
    },
    {
      scope: "apps/web",
      feature: "orders",
      role: "ui",
      files: [
        { path: "apps/web/o/a.ts", lines: 2 },
        { path: "apps/web/o/b.ts", lines: 3 },
        { path: "apps/web/o/c.ts", lines: 5 },
        { path: "apps/web/o/d.ts", lines: 1 },
      ],
    },
  ],
};

const pair = (
  id: string,
  a: [string, string, number, number],
  b: [string, string, number, number],
  choice: PairVerdict,
  confidence: number,
): PairInput => ({
  id,
  a: { path: a[0], function: a[1], lines: [a[2], a[3]] },
  b: { path: b[0], function: b[1], lines: [b[2], b[3]] },
  answers: { verdict: { choice, confidence } },
});

const PAIRS: PairInput[] = [
  pair(
    "p1",
    ["s/a.ts", "canEdit", 1, 10],
    ["s/b.ts", "mayEdit", 1, 8],
    "same_decision",
    0.9,
  ),
  pair(
    "p2",
    ["s/b.ts", "mayEdit", 1, 8],
    ["s/c.ts", "editAllowed", 3, 6],
    "same_decision",
    0.6,
  ),
  pair(
    "p3",
    ["s/d.ts", "isDue", 1, 5],
    ["s/e.ts", "dueNow", 1, 5],
    "same_decision",
    0.4,
  ),
  pair(
    "p4",
    ["s/f.ts", "fetchUser", 1, 6],
    ["s/g.ts", "fetchUser", 1, 4],
    "shared_helper",
    0.8,
  ),
  pair(
    "p5",
    ["s/h.ts", "fetchUser", 2, 4],
    ["s/f.ts", "fetchUser", 1, 6],
    "shared_helper",
    0.75,
  ),
  pair(
    "p6",
    ["s/i.ts", "toRow", 1, 3],
    ["s/j.ts", "mapRow", 1, 3],
    "shared_helper",
    0.9,
  ),
  pair(
    "p7",
    ["s/k.ts", "page", 1, 3],
    ["s/l.ts", "page", 1, 3],
    "shared_helper",
    0.6,
  ),
  pair(
    "p8",
    ["s/m.ts", "one", 1, 3],
    ["s/n.ts", "two", 1, 3],
    "look_alike",
    0.99,
  ),
];

/** The groups file after stage 6 over shape A, every cluster confirmed. */
async function groupsFile() {
  const jev = stubGroupJev(() => groupAnswer("same-rule", 0.95));
  const options = {
    policy: await stage6Policy(),
    ask: askGroupVerdict(jev),
    enrich: async (_item: unknown, state: JevState) => state,
  };
  const confirmed = await runStage(
    memoryArtifactStore<ClusterRecord>(),
    confirmStage(options),
    confirmInput(await clustersOf(SHAPE_A), options),
  );
  return groupsFileOf({
    confirmed: confirmed.artifact,
    owners: null,
    specs: [],
  });
}

const allInputs = async (): Promise<InventoryInputs> => ({
  unreachable: read("unreachable.json", UNREACHABLE),
  graph: read("graph.json", GRAPH),
  consolidate: read(".structure-sweep/consolidate.json", CONSOLIDATE),
  pairs: read(".structure-sweep/pairs.json", PAIRS),
  groups: read(".structure-sweep/groups.json", await groupsFile()),
});

const ofLever = (entries: readonly InventoryEntry[], lever: string) =>
  entries.filter((e) => e.lever === lever);

describe("structure-sweep inventory: levers", () => {
  it("A lists dead exports with the graph's end lines, test-only kept apart from no reference", async () => {
    const inventory = buildInventory(await allInputs());
    const dead = ofLever(inventory.entries, "dead-export");
    expect(dead.map((e) => [e.subject, e.deletions, e.signals])).toEqual([
      ["packages/a/src/old.ts:unusedLong", 20, ["unreachable:dead"]],
      [
        "packages/a/src/old.ts:onlyTested",
        4,
        [
          "unreachable:only-called-from-tests",
          "test-reference:packages/a/test/old.test.ts",
        ],
      ],
    ]);
    expect(dead[0]?.spans).toEqual([
      { file: "packages/a/src/old.ts", startLine: 5, endLine: 24 },
    ]);
    expect(dead[0]?.action).not.toBe(dead[1]?.action);
    expect(dead.every((e) => e.confidence === null)).toBe(true);
  });

  it("A falls back to the start line when no graph gives an end line", async () => {
    const inventory = buildInventory({
      ...(await allInputs()),
      graph: missing("--graph"),
    });
    for (const e of ofLever(inventory.entries, "dead-export")) {
      const [span] = e.spans;
      expect(span?.endLine).toBe(span?.startLine);
    }
  });

  it("B lists each merge proposal, biggest first, with whole-file spans", async () => {
    const inventory = buildInventory(await allInputs(), {
      fileLines: (path) => (path === "apps/web/o/c.ts" ? 9 : undefined),
    });
    const merges = ofLever(inventory.entries, "tiny-file-merge");
    expect(merges.map((e) => [e.subject, e.deletions])).toEqual([
      ["apps/web · orders · ui", 3],
      ["packages/design · ui · component", 2],
    ]);
    expect(merges[0]?.spans).toContainEqual({
      file: "apps/web/o/c.ts",
      startLine: 1,
      endLine: 9,
    });
    expect(merges[0]?.spans).toContainEqual({
      file: "apps/web/o/b.ts",
      startLine: 1,
      endLine: 3,
    });
  });

  it("C unions same-decision pairs at or over 0.5 into groups, with the weakest confidence", async () => {
    const inventory = buildInventory(await allInputs());
    const groups = ofLever(inventory.entries, "same-decision");
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.spans.map((s) => s.file)).toEqual([
      "s/a.ts",
      "s/b.ts",
      "s/c.ts",
    ]);
    expect(group?.confidence).toBe(0.6);
    expect(group?.deletions).toBe(8 + 4);
    expect(group?.signals).toEqual([
      "pairs:same_decision",
      "pair:p1",
      "pair:p2",
    ]);
  });

  it("D groups shared-helper pairs at or over 0.7 by function name", async () => {
    const inventory = buildInventory(await allInputs());
    const families = ofLever(inventory.entries, "shared-helper");
    expect(
      families.map((e) => [e.subject, e.spans.length, e.confidence]),
    ).toEqual([
      ["fetchUser", 3, 0.75],
      ["mapRow / toRow", 2, 0.9],
    ]);
  });

  it("E lists an exported name in two top-level scopes, never a generic, private or same-scope one", async () => {
    const inventory = buildInventory(await allInputs());
    const twins = ofLever(inventory.entries, "name-twin");
    expect(twins.map((e) => [e.subject, e.signals])).toEqual([
      [
        "formatMoney",
        ["graph:exported-name", "scope:packages/a", "scope:packages/b"],
      ],
    ]);
    expect(twins[0]?.deletions).toBe(6);
    expect(topLevelScope("src/x.ts")).toBe("src");
    expect(topLevelScope("x.ts")).toBe(".");
  });

  it("F lists the confirmed rule groups from the groups file", async () => {
    const inputs = await allInputs();
    const inventory = buildInventory(inputs);
    const rules = ofLever(inventory.entries, "rule-group");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.subject).toMatch(/^g-[0-9a-f]{12}$/);
      expect(rule.confidence).toBe(0.95);
      expect(rule.spans.length).toBeGreaterThan(0);
    }
  });

  it("orders entries by lever, then deletions, and gives each a content-derived id", async () => {
    const inventory = buildInventory(await allInputs());
    const letters = inventory.entries.map((e) => e.id[0]);
    expect(letters).toEqual([...letters].sort());
    for (const e of inventory.entries)
      expect(e.id).toMatch(/^[A-F]-[0-9a-f]{12}$/);
    expect(new Set(inventory.entries.map((e) => e.id)).size).toBe(
      inventory.entries.length,
    );
    const again = buildInventory(await allInputs());
    expect(again.entries.map((e) => e.id)).toEqual(
      inventory.entries.map((e) => e.id),
    );
  });

  it("an id changes with its content", async () => {
    const inputs = await allInputs();
    const before = ofLever(buildInventory(inputs).entries, "name-twin")[0]?.id;
    const moved: GraphInput = {
      functions: GRAPH.functions.map((f) =>
        f.name === "formatMoney" ? { ...f, endLine: f.endLine + 1 } : f,
      ),
    };
    const after = ofLever(
      buildInventory({ ...inputs, graph: read("graph.json", moved) }).entries,
      "name-twin",
    )[0]?.id;
    expect(after).not.toBe(before);
  });
});

describe("structure-sweep inventory: --exclude", () => {
  it("keeps an excluded file out of every tiny-file merge", async () => {
    const inventory = buildInventory(await allInputs(), {
      exclude: ["packages/design/**", "apps/web/o/d.ts"],
    });
    const merges = ofLever(inventory.entries, "tiny-file-merge");
    const files = merges.flatMap((e) => e.spans.map((s) => s.file));
    expect(files).toEqual([
      "apps/web/o/a.ts",
      "apps/web/o/b.ts",
      "apps/web/o/c.ts",
    ]);
    expect(merges[0]?.deletions).toBe(2);
  });

  it("matches globs by segment", () => {
    expect(globMatcher("packages/design")("packages/design/src/a.ts")).toBe(
      true,
    );
    expect(globMatcher("packages/*/src/*.ts")("packages/x/src/a.ts")).toBe(
      true,
    );
    expect(globMatcher("packages/*/src/*.ts")("packages/x/src/y/a.ts")).toBe(
      false,
    );
    expect(globMatcher("**/*.stories.ts")("a/b/c.stories.ts")).toBe(true);
    expect(globMatcher("**/*.stories.ts")("c.stories.ts")).toBe(true);
    expect(globMatcher("apps/web")("apps/webx/a.ts")).toBe(false);
  });
});

describe("structure-sweep inventory: skipped levers", () => {
  it("records every missing input as a skipped lever naming what it looked for", () => {
    const inventory = buildInventory({
      unreachable: missing("--unreachable"),
      graph: missing("--graph"),
      consolidate: missing(
        "--consolidate",
        ".structure-sweep/consolidate.json",
      ),
      pairs: missing("--pairs", ".structure-sweep/pairs.json"),
      groups: missing("--groups", ".structure-sweep/groups.json"),
    });
    expect(inventory.entries).toEqual([]);
    expect(inventory.levers).toEqual([
      {
        lever: "dead-export",
        state: "skipped",
        flag: "--unreachable",
        path: null,
        reason: "not given",
      },
      {
        lever: "tiny-file-merge",
        state: "skipped",
        flag: "--consolidate",
        path: ".structure-sweep/consolidate.json",
        reason: "no such file",
      },
      {
        lever: "same-decision",
        state: "skipped",
        flag: "--pairs",
        path: ".structure-sweep/pairs.json",
        reason: "no such file",
      },
      {
        lever: "shared-helper",
        state: "skipped",
        flag: "--pairs",
        path: ".structure-sweep/pairs.json",
        reason: "no such file",
      },
      {
        lever: "name-twin",
        state: "skipped",
        flag: "--graph",
        path: null,
        reason: "not given",
      },
      {
        lever: "rule-group",
        state: "skipped",
        flag: "--groups",
        path: ".structure-sweep/groups.json",
        reason: "no such file",
      },
    ]);
  });

  it("skips B when consolidate ran without sweep verdicts", async () => {
    const inventory = buildInventory({
      ...(await allInputs()),
      consolidate: read("c.json", { ...CONSOLIDATE, merge: null }),
    });
    expect(inventory.levers[1]).toMatchObject({
      lever: "tiny-file-merge",
      state: "skipped",
      path: "c.json",
    });
  });
});

describe("structure-sweep inventory: the command", () => {
  it("is listed in the usage text", () => {
    expect(INVENTORY_USAGE).toMatch(/^structure-sweep inventory/);
    expect(INVENTORY_USAGE).toMatch(/--exclude <glob>/);
  });

  /** A repository holding the inputs on disk, and a run of the command over it. */
  async function onDisk() {
    const root = repo({
      "apps/web/o/a.ts": "export const a = 1;\n",
      "apps/web/o/b.ts": "export const b = 1;\n\nexport const bb = 2;\n",
      "apps/web/o/c.ts": "export const c = 1;\n",
      "apps/web/o/d.ts": "export const d = 1;\n",
    });
    write(root, {
      "graphs/unreachable.json": JSON.stringify(UNREACHABLE),
      "graphs/graph.json": JSON.stringify(GRAPH),
      ".structure-sweep/consolidate.json": JSON.stringify(CONSOLIDATE),
      ".structure-sweep/pairs.json": JSON.stringify(PAIRS),
    });
    writeGroupsFile(
      join(root, ".structure-sweep/groups.json"),
      await groupsFile(),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    return { root, fetch };
  }

  const outputs = (root: string) => ({
    json: readFileSync(join(root, ".structure-sweep/inventory.json"), "utf8"),
    md: readFileSync(join(root, ".structure-sweep/inventory.md"), "utf8"),
  });

  it("writes byte-identical inventory.json and inventory.md on a re-run, calling nothing", async () => {
    const { root, fetch } = await onDisk();
    const argv = [
      "--unreachable",
      "graphs/unreachable.json",
      "--graph",
      "graphs/graph.json",
      "--exclude",
      "packages/design/**",
    ];
    const before = readdirSync(join(root, ".structure-sweep")).sort();
    inventoryCommand(argv, root);
    const first = outputs(root);
    inventoryCommand(argv, root);
    expect(outputs(root)).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(join(root, ".structure-sweep")).sort()).toEqual(
      [...before, "inventory.json", "inventory.md"].sort(),
    );

    const inventory = JSON.parse(first.json);
    expect(inventory.levers.map((l: { state: string }) => l.state)).toEqual(
      Array(6).fill("built"),
    );
    const merge = inventory.entries.find(
      (e: InventoryEntry) => e.lever === "tiny-file-merge",
    );
    // b.ts has three lines at HEAD, one of them blank: the span is the file, not its non-blank count.
    expect(merge.spans).toContainEqual({
      file: "apps/web/o/b.ts",
      startLine: 1,
      endLine: 3,
    });
    expect(first.md).toMatch(/^# Consolidation inventory/);
    expect(first.md).not.toMatch(/packages\/design\/src/);
    for (const e of inventory.entries) expect(first.md).toContain(e.id);
  });

  it("still exits cleanly with every lever it could build, naming what is missing", async () => {
    const { root } = await onDisk();
    inventoryCommand(
      [
        "--pairs",
        "nowhere/pairs.json",
        "--out",
        "out/inv.json",
        "--report",
        "out/inv.md",
      ],
      root,
    );
    expect(existsSync(join(root, ".structure-sweep/inventory.json"))).toBe(
      false,
    );
    const json = JSON.parse(readFileSync(join(root, "out/inv.json"), "utf8"));
    const md = readFileSync(join(root, "out/inv.md"), "utf8");
    const states = Object.fromEntries(
      json.levers.map((l: { lever: string; state: string }) => [
        l.lever,
        l.state,
      ]),
    );
    expect(states).toEqual({
      "dead-export": "skipped",
      "tiny-file-merge": "built",
      "same-decision": "skipped",
      "shared-helper": "skipped",
      "name-twin": "skipped",
      "rule-group": "built",
    });
    expect(md).toContain("skipped: no `nowhere/pairs.json` (`--pairs`)");
    expect(md).toContain("skipped: `--unreachable` was not given");
    expect(md).toContain("skipped: `--graph` was not given");
  });

  it("refuses an input that exists but is not its kind of file", async () => {
    const { root } = await onDisk();
    write(root, { ".structure-sweep/pairs.json": "{}" });
    expect(() => inventoryCommand([], root)).toThrow(/pairs\.json/);
  });
});
