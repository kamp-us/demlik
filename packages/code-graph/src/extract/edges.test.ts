import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TypeContext } from "../checker/context.js";
import { resolveImports } from "../syntax/imports.js";
import { type EdgeResult, resolveEdges } from "./edges.js";
import { discoverFunctions } from "./functions.js";
import { loadEdgeProject } from "./project.js";

function resolveMulti(files: { path: string; source: string }[]): {
  result: EdgeResult;
  ids: string[];
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-edges-")));
  try {
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    for (const f of files) fs.writeFileSync(path.join(root, f.path), f.source);
    const loaded = loadEdgeProject(root, "package", root);
    const { functions } = discoverFunctions(loaded.sourceFiles);
    const ids = functions.map((f) => f.id);
    const imports = resolveImports(root, loaded.sourceFiles, loaded.tsConfigPath);
    const ctx = TypeContext.open({
      rootAbsolute: root,
      tsConfigPath: loaded.tsConfigPath,
      sourceFiles: loaded.sourceFiles,
      functions,
    });
    try {
      return { result: resolveEdges(ctx, imports, ids), ids };
    } finally {
      ctx.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function resolve(source: string) {
  return resolveMulti([{ path: "fixture.ts", source }]);
}

describe("resolveCallee / C1 — callee ids", () => {
  it("resolved internal call → callee's function id", () => {
    const src = `function a() { return 1; }
function b() { return a(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("fixture.ts:a");
  });

  it("unresolved external call → external:NAME", () => {
    const src = `function b() { return globalThing(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("external:globalThing");
  });

  it("property-access external uses the last name", () => {
    const src = `function b(x) { return x.doStuff(); }`;
    const { result } = resolve(src);
    const bCalls = result.callsById.get("fixture.ts:b") ?? [];
    expect(bCalls.map((c) => c.calleeId)).toContain("external:doStuff");
  });
});

describe("resolveCallee / C1 — CROSS-FILE imported calls (import-alias regression)", () => {
  const FILES = [
    { path: "/a.ts", source: "export function helper() { return 1; }" },
    {
      path: "/b.ts",
      source: 'import { helper } from "./a";\nexport function caller() { return helper(); }',
    },
  ];

  it("an imported function call resolves to the real callee id across files", () => {
    const { result } = resolveMulti(FILES);
    const callerCalls = result.callsById.get("b.ts:caller") ?? [];
    expect(callerCalls.map((c) => c.calleeId)).toContain("a.ts:helper");
  });

  it("calledBy inverts across files (the blast-radius promise)", () => {
    const { result } = resolveMulti(FILES);
    const helperCalledBy = result.calledById.get("a.ts:helper") ?? [];
    expect(helperCalledBy.map((c) => c.callerId)).toContain("b.ts:caller");
  });
});

describe("imports / importedBy — re-export edges (export … from)", () => {
  it("named re-export `export { X } from './y'` produces an import edge + the inversion", () => {
    const { result } = resolveMulti([
      { path: "/y.ts", source: "export function X() { return 1; }" },
      { path: "/x.ts", source: 'export { X } from "./y";' },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toContain("./y");
    expect(result.importedByFile.get("y.ts") ?? []).toContain("x.ts");
  });

  it("star re-export `export * from './y'` produces an edge", () => {
    const { result } = resolveMulti([
      { path: "/y.ts", source: "export function X() { return 1; }" },
      { path: "/x.ts", source: 'export * from "./y";' },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toContain("./y");
    expect(result.importedByFile.get("y.ts") ?? []).toContain("x.ts");
  });

  it("default re-export `export { default } from './y'` produces an edge", () => {
    const { result } = resolveMulti([
      { path: "/y.ts", source: "export default function X() { return 1; }" },
      { path: "/x.ts", source: 'export { default } from "./y";' },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toContain("./y");
    expect(result.importedByFile.get("y.ts") ?? []).toContain("x.ts");
  });

  it("type re-export `export type … from './y'` produces an edge", () => {
    const { result } = resolveMulti([
      { path: "/y.ts", source: "export type T = number;" },
      { path: "/x.ts", source: 'export type { T } from "./y";' },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toContain("./y");
    expect(result.importedByFile.get("y.ts") ?? []).toContain("x.ts");
  });

  it("local `export { X }` with NO `from` produces NO edge", () => {
    const { result } = resolveMulti([
      { path: "/x.ts", source: "function X() { return 1; }\nexport { X };" },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toEqual([]);
    expect(result.importedByFile.get("x.ts") ?? []).toEqual([]);
  });
});

describe("imports / importedBy — dynamic import()", () => {
  it("`await import('./dyn.js')` produces an import edge + the inversion", () => {
    const { result } = resolveMulti([
      { path: "/dyn.ts", source: "export function d() { return 1; }" },
      { path: "/x.ts", source: 'async function f() { return await import("./dyn.js"); }' },
    ]);
    expect(result.importsByFile.get("x.ts") ?? []).toContain("./dyn.js");
    expect(result.importedByFile.get("dyn.ts") ?? []).toContain("x.ts");
  });
});

describe("imports / importEdges — type-only tagging", () => {
  it("`import type { X } from './y'` is tagged typeOnly: true", () => {
    const { result } = resolveMulti([
      { path: "/y.ts", source: "export type X = number;" },
      { path: "/x.ts", source: 'import type { X } from "./y";\nlet a: X = 1;' },
    ]);
    const edge = (result.importEdgesByFile.get("x.ts") ?? []).find((e) => e.specifier === "./y");
    expect(edge).toBeDefined();
    expect(edge?.typeOnly).toBe(true);
  });

  it("a value `import { z } from './z'` is tagged typeOnly: false", () => {
    const { result } = resolveMulti([
      { path: "/z.ts", source: "export function z() { return 1; }" },
      { path: "/x.ts", source: 'import { z } from "./z";\nfunction c() { return z(); }' },
    ]);
    const edge = (result.importEdgesByFile.get("x.ts") ?? []).find((e) => e.specifier === "./z");
    expect(edge).toBeDefined();
    expect(edge?.typeOnly).toBe(false);
  });
});

describe("imports — CJS require() / import = require() (pure-ESM: explicit non-goal)", () => {
  it.skip("require('./cjs') / import x = require('./cjs') — unsupported by design (pure-ESM)", () => {});
});

describe("A1 — overload signatures collapse to the implementation", () => {
  const src = `export function parse(x: string): number;
export function parse(x: number): number;
export function parse(x: string | number): number { return Number(x); }
export function caller() { return parse("1"); }`;

  it("enumerates exactly one `parse` node (the implementation)", () => {
    const { ids } = resolve(src);
    expect(ids.filter((id) => id === "fixture.ts:parse")).toEqual(["fixture.ts:parse"]);
  });

  it("the caller resolves to the single parse id (not a phantom signature)", () => {
    const { result } = resolve(src);
    const callerCalls = result.callsById.get("fixture.ts:caller") ?? [];
    expect(callerCalls.map((c) => c.calleeId)).toContain("fixture.ts:parse");
  });
});

describe("resolveCallee — a callable a factory built from a config object", () => {
  const FILES = [
    {
      path: "/define-rpc.ts",
      source: `export interface Spec<P, R> { parameters: P; execute: (p: P) => Promise<R> }
export function defineRpc<P, R>(spec: Spec<P, R>): (input: P) => Promise<R> {
  return async (input: P) => spec.execute(input);
}
export function eager<P>(spec: { setup(): void; execute(p: P): void }): (input: P) => void {
  spec.setup();
  return () => {};
}`,
    },
    {
      path: "/handler.ts",
      source: `import { defineRpc, eager } from "./define-rpc";
export const createProject = defineRpc({
  parameters: {},
  execute: async (p: object) => p,
});
export const methodShaped = defineRpc({
  parameters: {},
  async execute(p: object) { return p; },
});
export const setupOnly = eager({ setup() {}, execute() {} });`,
    },
    {
      path: "/store.ts",
      source: `import { createProject as createProjectHandler, methodShaped, setupOnly } from "./handler";
export function create(input: object) { return createProjectHandler(input); }
export function viaMethod(input: object) { return methodShaped(input); }
export function viaEager(input: object) { return setupOnly(input); }`,
    },
  ];

  const calleesOf = (id: string) => {
    const { result } = resolveMulti(FILES);
    return (result.callsById.get(id) ?? []).map((c) => c.calleeId);
  };

  it("resolves a call to the value into the config member the factory's returned function invokes", () => {
    expect(calleesOf("store.ts:create")).toEqual(["handler.ts:execute#0"]);
  });

  it("follows a method-shorthand member the same way", () => {
    expect(calleesOf("store.ts:viaMethod")).toEqual(["handler.ts:execute#1"]);
  });

  it("does not follow a member the factory only invokes while building the value", () => {
    expect(calleesOf("store.ts:viaEager")).toEqual(["external:setupOnly"]);
  });
});

describe("computeChainDepths (C5) — SCC longest path", () => {
  it("a leaf with no internal callees has depth 0", () => {
    const src = `function leaf() { return 1; }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:leaf")).toBe(0);
  });

  it("self-recursion collapses to depth 1", () => {
    const src = `function r(n) { return n > 0 ? r(n - 1) : 0; }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:r")).toBe(1);
  });

  it("mutual recursion a↔b collapses the SCC to depth 1", () => {
    const src = `function a(n) { return b(n); }
function b(n) { return a(n); }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(1);
    expect(result.chainDepthById.get("fixture.ts:b")).toBe(1);
  });

  it("DAG longest path: a→b→c gives depths 2,1,0", () => {
    const src = `function c() { return 1; }
function b() { return c(); }
function a() { return b(); }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(2);
    expect(result.chainDepthById.get("fixture.ts:b")).toBe(1);
    expect(result.chainDepthById.get("fixture.ts:c")).toBe(0);
  });

  it("externals are excluded from the chain", () => {
    const src = `function a() { return globalThing(); }`;
    const { result } = resolve(src);
    expect(result.chainDepthById.get("fixture.ts:a")).toBe(0);
  });
});

describe("C2 calledBy — inverted from calls", () => {
  it("a callee's calledBy lists its internal callers", () => {
    const src = `function a() { return 1; }
function b() { return a(); }`;
    const { result } = resolve(src);
    const aCalledBy = result.calledById.get("fixture.ts:a") ?? [];
    expect(aCalledBy.map((c) => c.callerId)).toContain("fixture.ts:b");
  });

  it("external callees never receive callers", () => {
    const src = `function b() { return globalThing(); }`;
    const { result } = resolve(src);
    expect(result.calledById.has("external:globalThing")).toBe(false);
  });
});
