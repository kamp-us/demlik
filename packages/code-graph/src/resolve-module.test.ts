import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExportDeclaration, type InProcessGraph, loadInProcessGraph } from "./resolve.js";

// A package whose entry files only re-export, the way a published package's barrels do: the
// question is asked of each entry module itself, with no file importing it.
let root = "";
const opened: InProcessGraph[] = [];

const files: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
  "src/fns.ts": [
    "/** Adds one. */",
    "export function plain(n: number): number {",
    "  return n + 1;",
    "}",
    "",
    "export function over(a: string): string;",
    "export function over(a: number): number;",
    "export function over(a: string | number): string | number {",
    "  return a;",
    "}",
    "",
  ].join("\n"),
  "src/types.ts": [
    "export type Alias = { readonly id: string };",
    "",
    "/** A shape. */",
    "export interface Shape {",
    "  readonly side: number;",
    "}",
    "",
  ].join("\n"),
  "src/values.ts": [
    "export class Box {",
    "  readonly v = 1;",
    "}",
    "",
    "export const LIMIT = 3;",
    "",
    'export const hidden = "declared, published by no entry";',
    "",
  ].join("\n"),
  "src/index.ts": 'export * from "./fns";\nexport * from "./types";\n',
  "src/testing/index.ts": 'export { Box } from "../values";\n',
  "src/renamed/index.ts": 'export { plain as increment } from "../fns";\n',
  "src/relay/index.ts": 'import { LIMIT } from "../values";\nexport { LIMIT };\n',
  "src/empty/index.ts": "export const unrelated = 0;\n",
};

const entries = {
  ".": "src/index.ts",
  "./testing": "src/testing/index.ts",
  "./renamed": "src/renamed/index.ts",
  "./relay": "src/relay/index.ts",
  "./empty": "src/empty/index.ts",
} as const;
type Subpath = keyof typeof entries;

const names = ["plain", "over", "Alias", "Shape", "Box", "LIMIT", "increment", "hidden"] as const;
type Name = (typeof names)[number];

const at = (file: string, name: string, line: number): ExportDeclaration => ({
  file: path.join(root, file),
  name,
  line,
});

// Every (entry, name) pair the fixture publishes; every pair absent here answers null.
const published = (): Partial<Record<Subpath, Partial<Record<Name, ExportDeclaration>>>> => ({
  ".": {
    plain: at("src/fns.ts", "plain", 2),
    over: at("src/fns.ts", "over", 6),
    Alias: at("src/types.ts", "Alias", 1),
    Shape: at("src/types.ts", "Shape", 4),
  },
  "./testing": { Box: at("src/values.ts", "Box", 1) },
  "./renamed": { increment: at("src/fns.ts", "plain", 2) },
  "./relay": { LIMIT: at("src/values.ts", "LIMIT", 5) },
});

function load(): InProcessGraph {
  const graph = loadInProcessGraph(root);
  if (graph === null) throw new Error("fixture has no tsconfig");
  opened.push(graph);
  return graph;
}

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

function everyAnswer(graph: InProcessGraph): Record<string, ExportDeclaration | null> {
  const answers: Record<string, ExportDeclaration | null> = {};
  for (const [subpath, entry] of Object.entries(entries))
    for (const name of names)
      answers[`${subpath} ${name}`] = graph.resolveModuleExport(path.join(root, entry), name);
  return answers;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-module-")));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
});

afterAll(() => {
  for (const graph of opened) graph.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveModuleExport", () => {
  it("answers which entry publishes each name, with its declaration, writing no file", () => {
    const before = listFiles(root);
    const graph = load();
    const first = everyAnswer(graph);

    const expected: Record<string, ExportDeclaration | null> = {};
    for (const subpath of Object.keys(entries) as Subpath[])
      for (const name of names)
        expected[`${subpath} ${name}`] = published()[subpath]?.[name] ?? null;
    expect(first).toEqual(expected);
    for (const subpath of Object.keys(entries)) expect(first[`${subpath} hidden`]).toBeNull();

    expect(everyAnswer(graph)).toEqual(first);
    expect(everyAnswer(load())).toEqual(first);
    expect(listFiles(root)).toEqual(before);
  });

  it("answers null for a missing file and for a name the module does not export", () => {
    const graph = load();
    expect(graph.resolveModuleExport(path.join(root, "src/nowhere.ts"), "plain")).toBeNull();
    expect(graph.resolveModuleExport(path.join(root, "src/index.ts"), "absent")).toBeNull();
  });

  it("puts an overloaded function on its first overload signature's line", () => {
    expect(load().resolveModuleExport(path.join(root, "src/fns.ts"), "over")).toEqual(
      at("src/fns.ts", "over", 6),
    );
  });

  it("refuses a query after dispose", () => {
    const graph = load();
    graph.dispose();
    expect(() => graph.resolveModuleExport(path.join(root, "src/index.ts"), "plain")).toThrow(
      /disposed/,
    );
  });
});

describe("resolvePublishingSubpaths", () => {
  const absoluteEntries = () =>
    Object.fromEntries(
      Object.entries(entries).map(([subpath, file]) => [subpath, path.join(root, file)]),
    );

  it("lists the caller's subpaths that publish a name, in map order, with the declaration", () => {
    const graph = load();
    for (const name of names) {
      const expected = (Object.keys(entries) as Subpath[]).flatMap((subpath) => {
        const declaration = published()[subpath]?.[name];
        return declaration === undefined
          ? []
          : [{ subpath, entry: path.join(root, entries[subpath]), declaration }];
      });
      expect(graph.resolvePublishingSubpaths(absoluteEntries(), name)).toEqual(expected);
    }
    expect(graph.resolvePublishingSubpaths(absoluteEntries(), "hidden")).toEqual([]);
  });

  it("names a missing entry file as unresolvable for every name, and leaves the others as they were", () => {
    const graph = load();
    const missing = path.join(root, "src/moved/index.ts");
    const broken = { ...absoluteEntries(), "./testing": missing };
    for (const name of [...names, "absent"]) {
      const correct = graph.resolvePublishingSubpaths(absoluteEntries(), name);
      const answers = graph.resolvePublishingSubpaths(broken, name);
      expect(answers).toContainEqual({
        subpath: "./testing",
        given: missing,
        entry: missing,
        unresolvable: "missing-entry-file",
      });
      expect(answers.filter((answer) => answer.subpath !== "./testing")).toEqual(
        correct.filter((answer) => answer.subpath !== "./testing"),
      );
    }
    expect(graph.resolvePublishingSubpaths(broken, "Box")).toEqual([
      {
        subpath: "./testing",
        given: missing,
        entry: missing,
        unresolvable: "missing-entry-file",
      },
    ]);
  });

  it("resolves a relative entry against the working directory, as its absolute form", () => {
    const graph = load();
    const relativeEntries = Object.fromEntries(
      Object.entries(absoluteEntries()).map(([subpath, file]) => [
        subpath,
        path.relative(process.cwd(), file),
      ]),
    );
    for (const name of names)
      expect(graph.resolvePublishingSubpaths(relativeEntries, name)).toEqual(
        graph.resolvePublishingSubpaths(absoluteEntries(), name),
      );

    const relativeMissing = path.relative(process.cwd(), path.join(root, "src/moved/index.ts"));
    expect(graph.resolvePublishingSubpaths({ "./moved": relativeMissing }, "plain")).toEqual([
      {
        subpath: "./moved",
        given: relativeMissing,
        entry: path.join(root, "src/moved/index.ts"),
        unresolvable: "missing-entry-file",
      },
    ]);
  });
});
