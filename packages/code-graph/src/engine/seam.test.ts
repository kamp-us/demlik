import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The engines code-graph reads TypeScript with sit behind src/engine: tsgo's API is `unstable/*`
// and pinned to a dev build, so one module owns every import of it, and oxc's two packages stay in
// the same directory. ts-morph is gone from this package entirely.

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNED = ["src", "scripts", "bench"];
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

function importersOf(matches: (specifier: string) => boolean): string[] {
  const out: string[] = [];
  for (const dir of SCANNED) {
    for (const file of filesUnder(path.join(PACKAGE_DIR, dir))) {
      if (file.endsWith("seam.test.ts")) continue;
      const text = fs.readFileSync(file, "utf8");
      const specifiers = [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? "");
      if (specifiers.some(matches))
        out.push(path.relative(PACKAGE_DIR, file).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

const isPackage = (name: string) => (specifier: string) =>
  specifier === name || specifier.startsWith(`${name}/`);

describe("engine seam", () => {
  it("imports @typescript/native-preview from exactly one module", () => {
    expect(importersOf(isPackage("@typescript/native-preview"))).toEqual(["src/engine/tsgo.ts"]);
  });

  it("imports oxc-parser and oxc-resolver only from src/engine", () => {
    const importers = importersOf(
      (s) => isPackage("oxc-parser")(s) || isPackage("oxc-resolver")(s),
    );
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((file) => !file.startsWith("src/engine/"))).toEqual([]);
  });

  it("imports ts-morph nowhere", () => {
    expect(importersOf(isPackage("ts-morph"))).toEqual([]);
  });
});
