import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TypeContext } from "../../checker/context.js";
import { resolveImports } from "../../syntax/imports.js";
import { runCli } from "../../test-helpers/ratchet-repo.js";
import { resolveEdges } from "../edges.js";
import { discoverFunctions } from "../functions.js";
import { loadEdgeProject } from "../project.js";

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    module: "ESNext",
    moduleResolution: "Bundler",
    target: "ES2022",
    allowImportingTsExtensions: true,
    noEmit: true,
  },
});

let top: string;

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-callee-")));
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

function write(files: Readonly<Record<string, string>>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

// The edge pass over `analyzed` (a folder under the fixture), with the fixture's own tsconfig.
function callsOf(analyzed: string): Map<string, string[]> {
  const root = path.join(top, analyzed);
  const loaded = loadEdgeProject(root, "package", top);
  const { functions } = discoverFunctions(loaded.sourceFiles);
  const imports = resolveImports(root, loaded.sourceFiles, loaded.tsConfigPath);
  const ctx = TypeContext.open({
    rootAbsolute: root,
    tsConfigPath: loaded.tsConfigPath,
    sourceFiles: loaded.sourceFiles,
    functions,
  });
  try {
    const { callsById } = resolveEdges(
      ctx,
      imports,
      functions.map((f) => f.id),
    );
    return new Map([...callsById].map(([id, calls]) => [id, calls.map((c) => c.calleeId)]));
  } finally {
    ctx.close();
  }
}

// The issue's two-file fixture (#751): an exported arrow whose only caller is another arrow.
const ISSUE_FIXTURE = {
  "tsconfig.json": TSCONFIG,
  "src/lib.ts": [
    "export const innerArrow = (x: number) => x + 1;",
    "export const outerArrow = (x: number) => innerArrow(x);",
    "export function innerDecl(x: number) {",
    "\treturn x + 2;",
    "}",
    "export const outerDecl = (x: number) => innerDecl(x);",
    "",
  ].join("\n"),
  "src/run.ts": [
    'import {outerArrow, outerDecl} from "./lib.ts";',
    "console.log(outerArrow(1), outerDecl(1));",
    "",
  ].join("\n"),
};

describe("a call to a const-bound arrow is a call edge, so --unreachable does not call it dead", () => {
  it("reports neither the inner arrow nor the inner declaration on the issue's fixture", () => {
    write(ISSUE_FIXTURE);
    const run = runCli([top, "--unreachable", "--json"]);
    expect(run.code).toBe(0);
    const ids = (JSON.parse(run.stdout) as { unreachable: { id: string }[] }).unreachable.map(
      (row) => row.id,
    );
    expect(ids).not.toContain("src/lib.ts:innerArrow");
    expect(ids).not.toContain("src/lib.ts:innerDecl");
  });

  it("gives outerArrow a call to the innerArrow node, and innerArrow the caller", () => {
    write(ISSUE_FIXTURE);
    const run = runCli([top, "--graph", "--edges", "--json"]);
    expect(run.code).toBe(0);
    type Fn = {
      id: string;
      edges: { calls: { calleeId: string }[]; calledBy: { callerId: string }[] };
    };
    const functions = (JSON.parse(run.stdout) as { functions: Fn[] }).functions;
    const byId = new Map(functions.map((fn) => [fn.id, fn]));
    const outer = byId.get("src/lib.ts:outerArrow");
    expect(outer?.edges.calls.map((c) => c.calleeId)).toEqual(["src/lib.ts:innerArrow"]);
    const inner = byId.get("src/lib.ts:innerArrow");
    expect(inner?.edges.calledBy.map((c) => c.callerId)).toEqual(["src/lib.ts:outerArrow"]);
  });
});

describe("resolveCallee — every callee shape resolves to its node id", () => {
  const SHAPES = {
    "tsconfig.json": TSCONFIG,
    "src/lib.ts": [
      "export const exported = (x: number) => x + 1;",
      "const local = (x: number) => x * 2;",
      "const fexpr = function (x: number) {",
      "\treturn x - 1;",
      "};",
      "export function decl(x: number) {",
      "\treturn x + 3;",
      "}",
      "export function sameFile(x: number) {",
      "\treturn exported(x) + local(x) + fexpr(x) + decl(x);",
      "}",
      "",
    ].join("\n"),
    "src/other.ts": [
      'import { exported } from "./lib.ts";',
      "export function crossFile(x: number) {",
      "\treturn exported(x);",
      "}",
      "",
    ].join("\n"),
  };

  it("an exported arrow, a local arrow, a function expression and a declaration, same file", () => {
    write(SHAPES);
    expect(callsOf(".").get("src/lib.ts:sameFile")).toEqual([
      "src/lib.ts:decl",
      "src/lib.ts:exported",
      "src/lib.ts:fexpr",
      "src/lib.ts:local",
    ]);
  });

  it("an exported arrow called from another file through an import", () => {
    write(SHAPES);
    expect(callsOf(".").get("src/other.ts:crossFile")).toEqual(["src/lib.ts:exported"]);
  });
});

describe("resolveCallee — a target outside the analyzed folder keeps its workspace: id", () => {
  it("names the arrow and the declaration by file and name when neither is a node in this run", () => {
    write({
      "tsconfig.json": TSCONFIG,
      "lib/helpers.ts": [
        "export const arrowHelper = (x: number) => x + 1;",
        "export function declHelper(x: number) {",
        "\treturn x + 2;",
        "}",
        "",
      ].join("\n"),
      "app/main.ts": [
        'import { arrowHelper, declHelper } from "../lib/helpers.ts";',
        "export function main(x: number) {",
        "\treturn arrowHelper(x) + declHelper(x);",
        "}",
        "",
      ].join("\n"),
    });
    expect(callsOf("app").get("main.ts:main")).toEqual([
      "workspace:../lib/helpers.ts:arrowHelper",
      "workspace:../lib/helpers.ts:declHelper",
    ]);
  });
});
