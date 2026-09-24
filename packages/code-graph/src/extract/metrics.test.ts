import { Project, type SourceFile } from "ts-morph";
import { describe, expect, it } from "vitest";
import { discoverFunctions } from "./functions.js";
import {
  collectModuleCommentRanges,
  computeFunctionMetrics,
  moduleCommentLines,
} from "./metrics.js";

function parse(source: string, name = "fixture.ts"): SourceFile {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    skipAddingFilesFromTsConfig: true,
  });
  return project.createSourceFile(name, source);
}

function metricsByName(source: string): Map<string, ReturnType<typeof computeFunctionMetrics>> {
  const sf = parse(source);
  const { functions } = discoverFunctions("/", [sf]);
  const out = new Map<string, ReturnType<typeof computeFunctionMetrics>>();
  for (const f of functions) out.set(f.name, computeFunctionMetrics(f.node));
  return out;
}

describe("complexity (B3) — token counting", () => {
  it("base complexity of a trivial function is 1", () => {
    const m = metricsByName("function f() { return 1; }");
    expect(m.get("f")?.complexity).toBe(1);
  });

  it("counts each && / || / ?? token exactly once (no double-count)", () => {
    const m = metricsByName("function f(a, b, c, d) { return a && b || c ?? d; }");
    expect(m.get("f")?.complexity).toBe(4);
  });

  it("counts each CaseClause but NOT default", () => {
    const src = `function f(x) {
      switch (x) {
        case 1: return 1;
        case 2: return 2;
        case 3: return 3;
        default: return 0;
      }
    }`;
    expect(metricsByName(src).get("f")?.complexity).toBe(4);
  });

  it("counts ternary, catch, and loops", () => {
    const src = `function f(x) {
      try {
        for (const i of x) {}
        while (x) {}
        return x ? 1 : 2;
      } catch (e) {}
    }`;
    expect(metricsByName(src).get("f")?.complexity).toBe(5);
  });

  it("named-callable boundary: a nested NAMED fn does not inflate the parent", () => {
    const src = `function parent(a, b) {
      function child(c, d) { return c && d; }
      return a || b;
    }`;
    const m = metricsByName(src);
    expect(m.get("parent")?.complexity).toBe(2);
    expect(m.get("child")?.complexity).toBe(2);
  });

  it("anonymous callback DOES contribute to the enclosing function", () => {
    const src = `function f(arr) {
      return arr.map((x) => x && x.y);
    }`;
    expect(metricsByName(src).get("f")?.complexity).toBe(2);
  });
});

describe("nesting (B2) — isDepthIncreasing", () => {
  it("if-block increases depth", () => {
    const src = `function f(a) { if (a) { if (a) { return 1; } } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(2);
  });

  it("loops increase depth", () => {
    const src = `function f(xs) { for (const x of xs) { while (x) { return 1; } } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(2);
  });

  it("switch increases depth", () => {
    const src = `function f(x) { switch (x) { case 1: return 1; } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("catch increases depth", () => {
    const src = `function f() { try { return 1; } catch (e) { return 2; } }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("anonymous callback body increases depth", () => {
    const src = `function f(arr) { return arr.map((x) => { return x; }); }`;
    expect(metricsByName(src).get("f")?.nestingDepth).toBe(1);
  });

  it("named-callable boundary stops depth accounting", () => {
    const src = `function parent() {
      function child() { if (1) { if (1) { return 1; } } }
      return 1;
    }`;
    const m = metricsByName(src);
    expect(m.get("parent")?.nestingDepth).toBe(0);
    expect(m.get("child")?.nestingDepth).toBe(2);
  });
});

describe("comment counting (A4)", () => {
  it("does not double-count JSDoc (leading ranges already include it)", () => {
    const src = `/**
 * Two-line JSDoc.
 */
function f() { return 1; }`;
    expect(metricsByName(src).get("f")?.commentLines).toBe(3);
  });

  it("dedups consecutive line comments and counts inner comments", () => {
    const src = `// a
// b
function f() {
  // inner
  return 1;
}`;
    expect(metricsByName(src).get("f")?.commentLines).toBe(3);
  });

  it("counts TRAILING comments on every branch (no false dense-undocumented)", () => {
    const src = `function f(x) {
  if (x > 0) return 1; // positive branch
  if (x < 0) return -1; // negative branch
  return 0; // zero branch
}`;
    const m = metricsByName(src);
    expect(m.get("f")?.commentLines).toBeGreaterThan(0);
    expect(m.get("f")?.commentLines).toBe(3);
  });

  it("module total = file comment lines, each function count is a subset", () => {
    const src = `// top of file
function f() {
  // inside f
  return 1;
}
// between
function g() { return 2; }`;
    const sf = parse(src);
    const { functions } = discoverFunctions("/", [sf]);
    const total = moduleCommentLines(sf);
    const byName = new Map(
      functions.map((fn) => [fn.name, computeFunctionMetrics(fn.node).commentLines]),
    );
    expect(total).toBe(3);
    expect(byName.get("f")).toBe(2);
    expect(byName.get("f") ?? 0).toBeLessThanOrEqual(total);
    expect(byName.get("g") ?? 0).toBeLessThanOrEqual(total);
  });
});

describe("LOC (B1)", () => {
  it("loc = endLine - startLine + 1, leading // not counted", () => {
    const src = `// leading comment, not part of loc
function f() {
  return 1;
}`;
    expect(metricsByName(src).get("f")?.loc).toBe(3);
  });
});

describe("the two comments forEachDescendant cannot reach", () => {
  it("counts a comment sitting before a closing brace", () => {
    const sf = parse(`function f() {
  try { go(); } catch {
    // swallowed on purpose
  }
}
`);
    const texts = collectModuleCommentRanges(sf).map((c) => c.text);
    expect(texts).toContain("// swallowed on purpose");
  });

  it("counts a JSX comment, which TypeScript reports as no trivia at all", () => {
    const sf = parse(`const x = (<div>\n  {/* jsx */}\n  <b />\n</div>);\n`, "a.tsx");
    const texts = collectModuleCommentRanges(sf).map((c) => c.text.trim());
    expect(texts).toContain("/* jsx */");
  });

  it("counts a MULTI-LINE JSX comment once per physical line", () => {
    const sf = parse(`const x = (<div>\n  {/* one\n      two */}\n</div>);\n`, "a.tsx");
    expect(moduleCommentLines(sf)).toBe(2);
  });
});
