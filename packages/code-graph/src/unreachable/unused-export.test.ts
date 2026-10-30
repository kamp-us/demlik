import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../test-helpers/ratchet-repo.js";
import { UNREACHABLE_LEDGER_FILENAME } from "./ledger.js";

const TSCONFIG =
  '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" }, "include": ["src"] }\n';

// `packages/app`: `exports` names `src/api.ts`; `src/jobs/*.ts` exporting `run` is an entry by the
// node-kinds convention. `src/internal.ts` holds the four exports only their own file needs.
const FILES: Readonly<Record<string, string>> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "node-kinds.json": JSON.stringify({
    entryExportConventions: { jobs: { files: "src/jobs/*.ts", exports: ["run"] } },
  }),
  "packages/app/package.json": JSON.stringify({
    name: "app",
    private: true,
    exports: { ".": "./src/api.ts" },
  }),
  "packages/app/tsconfig.json": TSCONFIG,
  "packages/app/src/api.ts": [
    'import { formatName as fmt, parse } from "./format.js";',
    'import { twice } from "./shared.js";',
    "",
    "export function publicApi(n: number): string {",
    "  return fmt(String(twice(parse(String(n)))));",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/format.ts": [
    "export function formatName(s: string): string {",
    "  return s.trim();",
    "}",
    "",
    "export function parse(s: string): number {",
    "  return s.length;",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/shared.ts": "export function twice(n: number): number {\n  return n * 2;\n}\n",
  "packages/app/src/internal.ts": [
    "export interface Options {",
    "  factor: number;",
    "}",
    "",
    "export function scale(n: number, o: Options): number {",
    "  return n * o.factor;",
    "}",
    "",
    "export const clamp = (n: number): number => Math.max(0, n);",
    "",
    "export function parse(text: string): number {",
    "  return Number(text);",
    "}",
    "",
    "export function compute(n: number): number {",
    "  return clamp(scale(parse(String(n)), { factor: 2 }));",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/reader.ts": [
    "function parse(s: string): string[] {",
    '  return s.split(",");',
    "}",
    "",
    "export function readList(s: string): string[] {",
    "  return parse(s);",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/relay.ts": 'export { readList } from "./reader.js";\n',
  "packages/app/src/limits.ts": [
    "export const LIMIT = 10;",
    "",
    "export function limited(n: number): number {",
    "  return Math.min(n, LIMIT);",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/limits.test.ts": [
    'import { LIMIT, limited } from "./limits.js";',
    "",
    "export function check(): boolean {",
    "  return limited(20) === LIMIT;",
    "}",
    "",
  ].join("\n"),
  "packages/app/src/dead.ts": "export function orphan(): number {\n  return 1;\n}\n",
  "packages/app/src/jobs/cleanup.ts": [
    'import { compute } from "../internal.js";',
    'import { limited } from "../limits.js";',
    'import { twice } from "../shared.js";',
    "",
    "export function run(): number {",
    "  return limited(twice(compute(1)));",
    "}",
    "",
  ].join("\n"),
};

const FOUR = [
  "src/internal.ts:clamp",
  "src/internal.ts:interface:Options",
  "src/internal.ts:parse",
  "src/internal.ts:scale",
];

let top: string;
let app: string;
let ledgerFile: string;
let nodeKinds: string;

function writeTree(files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-unused-export-")));
  writeTree(FILES);
  app = path.join(top, "packages", "app");
  ledgerFile = path.join(top, UNREACHABLE_LEDGER_FILENAME);
  nodeKinds = path.join(top, "node-kinds.json");
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

const unreachable = (...flags: string[]) =>
  runCli([app, "--unreachable", "--node-kinds", nodeKinds, ...flags]);

type Entry = { scope: string; kind: string; id: string; reason: string };
const readLedger = (): Entry[] => JSON.parse(fs.readFileSync(ledgerFile, "utf8")).entries;

describe("unused-export: an export only its own file needs", () => {
  it("lists exactly the four, deterministically, beside the unchanged unreachable report", () => {
    const first = unreachable("--json");
    expect(first.code).toBe(0);
    const report = JSON.parse(first.stdout);
    expect(report.unusedExports).toEqual([
      {
        id: "src/internal.ts:clamp",
        file: "src/internal.ts",
        startLine: 9,
        symbolKind: "function",
      },
      {
        id: "src/internal.ts:interface:Options",
        file: "src/internal.ts",
        startLine: 1,
        symbolKind: "interface",
      },
      {
        id: "src/internal.ts:parse",
        file: "src/internal.ts",
        startLine: 11,
        symbolKind: "function",
      },
      {
        id: "src/internal.ts:scale",
        file: "src/internal.ts",
        startLine: 5,
        symbolKind: "function",
      },
    ]);
    // The function nothing calls stays `dead` and carries no `unused-export` beside it.
    expect(report.unreachable).toEqual([
      {
        id: "src/dead.ts:orphan",
        file: "src/dead.ts",
        startLine: 1,
        category: "dead",
        testReferences: [],
      },
    ]);
    // What code-graph 0.12.0 prints for this fixture, before the finding existed.
    expect(report.withheld).toEqual([
      { id: "src/format.ts:formatName", reason: "called-by-withheld" },
      { id: "src/format.ts:parse", reason: "called-by-withheld" },
      { id: "src/api.ts:publicApi", reason: "public-entry-surface" },
      { id: "src/reader.ts:readList", reason: "referenced-in-non-test-file" },
    ]);
    expect(unreachable("--json").stdout).toBe(first.stdout);
  });

  it("keeps the counts of the reach pass at 0.12.0's", () => {
    const graph = JSON.parse(
      runCli([app, "--unreachable", "--node-kinds", nodeKinds, "--graph"]).stdout,
    );
    expect(graph.reachability.reachableCount).toBe(7);
    expect(graph.reachability.exportedCount).toBe(12);
    expect(graph.reachability.entryCount).toBe(1);
  });

  it("gates the four in --ci, records them, passes, and prunes one whose export is dropped", () => {
    const failed = unreachable("--ci");
    expect(failed.code).toBe(1);
    for (const id of FOUR) expect(failed.stdout).toContain(`unused-export  ${id}`);
    expect(failed.stdout).toContain("dead  src/dead.ts:orphan");

    expect(unreachable("--accept-dead", "--reason", "baseline").code).toBe(0);
    expect(readLedger().filter((e) => e.kind === "unused-export")).toEqual(
      FOUR.map((id) => ({ scope: "packages/app", kind: "unused-export", id, reason: "baseline" })),
    );
    expect(unreachable("--ci").code).toBe(0);

    const internal = path.join(app, "src", "internal.ts");
    const text = fs.readFileSync(internal, "utf8");
    fs.writeFileSync(internal, text.replace("export const clamp", "const clamp"));
    const before = readLedger();
    const pruned = unreachable("--ci");
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain("pruned 1 entry");
    expect(pruned.stdout).toContain("unused-export  src/internal.ts:clamp");
    expect(readLedger()).toEqual(
      before.filter((e) => !(e.kind === "unused-export" && e.id === "src/internal.ts:clamp")),
    );
  });

  it("--dead-only neither fails on nor prunes an unused-export entry", () => {
    fs.writeFileSync(
      ledgerFile,
      `${JSON.stringify({
        entries: [
          { scope: "packages/app", kind: "dead", id: "src/dead.ts:orphan", reason: "kept" },
          { scope: "packages/app", kind: "unused-export", id: "src/gone.ts:gone", reason: "kept" },
        ],
      })}\n`,
    );
    const run = unreachable("--ci", "--dead-only", "--json");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).gated).toEqual(["dead"]);
    expect(readLedger().map((e) => e.id)).toEqual(["src/dead.ts:orphan", "src/gone.ts:gone"]);
  });
});

describe("unused-export: what counts as public", () => {
  it('reports nothing under a wildcard export such as "./dist/*", which makes every file public', () => {
    writeTree({
      "packages/app/package.json": JSON.stringify({
        name: "app",
        private: true,
        exports: { "./dist/*": "./dist/*" },
      }),
    });
    const report = JSON.parse(unreachable("--json").stdout);
    expect(report.unusedExports).toEqual([]);
  });
});

describe("unused-export: a file that takes a whole module uses every export of it", () => {
  it.each([
    ["a namespace import", 'import * as m from "./mod.js";\n\nexport const size = m.one;\n'],
    ["a star re-export", 'export * from "./mod.js";\n'],
    [
      "a dynamic import",
      'export async function load(): Promise<unknown> {\n  return import("./mod.js");\n}\n',
    ],
  ])("%s", (_, user) => {
    writeTree({
      "packages/app/src/mod.ts": "export const one = 1;\n\nexport const two = 2;\n",
      "packages/app/src/user.ts": user,
    });
    const report = JSON.parse(unreachable("--json").stdout);
    const ids: string[] = report.unusedExports.map((u: { id: string }) => u.id);
    expect(ids.filter((id) => id.startsWith("src/mod.ts"))).toEqual([]);
  });
});
