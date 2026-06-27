import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../src/pure
const PURE_ENTRY = resolve(HERE, "index.ts");
const RUNTIME_ROOT = resolve(HERE, "../index.ts"); // where run/Store/host live
const PREDICTION_DIR = resolve(HERE, "../prediction");

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // external pkg — outside our graph
  const base = resolve(dirname(fromFile), spec);
  for (const c of [
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    base,
  ]) {
    try {
      readFileSync(c, "utf8");
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function collectGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  // every module specifier after a `from`, plus bare `import "x"`
  const FROM = /from\s*["']([^"']+)["']/g;
  const BARE = /\bimport\s*["']([^"']+)["']/g;
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const specs = new Set<string>();
    for (const m of src.matchAll(FROM)) specs.add(m[1]);
    for (const m of src.matchAll(BARE)) specs.add(m[1]);
    for (const spec of specs) {
      const resolved = resolveSpec(file, spec);
      if (resolved !== null) stack.push(resolved);
    }
  }
  return seen;
}

describe("@demlik/tea/pure import-graph boundary (ADR 0006, #213)", () => {
  const graph = collectGraph(PURE_ENTRY);

  it("never transitively imports the runtime root (run/Store/host)", () => {
    expect(graph.has(RUNTIME_ROOT)).toBe(false);
  });

  it("stays within the pure-core and prediction leaves", () => {
    const stray = [...graph].filter(
      (f) => !f.startsWith(HERE) && !f.startsWith(PREDICTION_DIR),
    );
    expect(stray).toEqual([]);
  });

  it("exposes the fold seam and the ack primitive from one client-safe path", async () => {
    const mod = await import("./index");
    expect(typeof mod.foldMsgs).toBe("function");
    expect(typeof mod.partitionByAck).toBe("function");
  });
});
