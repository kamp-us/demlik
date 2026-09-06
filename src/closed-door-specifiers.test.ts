// ═══════════════════════════════════════════════════════════════════════════
// NO PROSE POINTS AT A DOOR THAT IS NOT THERE.
//
// `exports` in `package.json` IS the public contract (MAINTAINING.md), and the
// epic that moved the composed flows behind `internal/` closed eleven subpaths
// that prose kept naming. Nothing gated it: a `@demlik/tea/work-queue` inside a
// JSDoc comment is not an import, so typecheck, lint and the suite all stayed
// green while `.patterns/` — the surface CLAUDE.md tells agents to trust over
// their own recollection — described a door a reader cannot open (#81).
//
// So the specifier is checked wherever it appears, not only where it is
// imported: every tracked file under `.patterns/` and `src/`, minus the tests
// (this file names closed doors on purpose, in its own fixtures).
//
// A closed door is fixed by REWRITING the prose, never by widening `exports` —
// the in-tree path (`src/internal/work-queue/ops.ts`) is what a reader can
// actually follow, and it is what the sweep for #81 put there.
// ═══════════════════════════════════════════════════════════════════════════
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every `@demlik/tea…` specifier in `text`, whole. The trailing-extension arm
 * keeps `@demlik/tea/devtools/styles.css` — a real subpath — from truncating to
 * `@demlik/tea/devtools/styles`, which `exports` does not carry and which would
 * therefore read as a violation.
 */
const SPECIFIER = /@demlik\/tea(?:\/[a-z0-9-]+)*(?:\.[a-z]{2,4})?/g;

/** The `@demlik/tea…` specifiers in `text` that `allowed` does not carry. */
function closedDoorSpecifiers(
  text: string,
  allowed: ReadonlySet<string>,
): string[] {
  return [...text.matchAll(SPECIFIER)]
    .map((m) => m[0])
    .filter((s) => !allowed.has(s));
}

/** The published specifier for every key in `exports`, `.` included. */
function publishedSpecifiers(): Set<string> {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as {
    exports: Record<string, unknown>;
  };
  return new Set(
    Object.keys(pkg.exports).map((key) =>
      key === "." ? "@demlik/tea" : `@demlik/tea/${key.slice(2)}`,
    ),
  );
}

/** Tracked, non-test files on the two surfaces this guard owns. */
function scannedFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--", ".patterns", "src", ":!*.test.ts", ":!*.test.tsx"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim();
  return out === "" ? [] : out.split("\n");
}

describe("closedDoorSpecifiers", () => {
  const allowed = new Set([
    "@demlik/tea",
    "@demlik/tea/mem",
    "@demlik/tea/devtools/styles.css",
  ]);

  it("flags a subpath `exports` does not carry", () => {
    expect(
      closedDoorSpecifiers("see `@demlik/tea/work-queue` for the ops", allowed),
    ).toEqual(["@demlik/tea/work-queue"]);
  });

  it("flags one inside a JSDoc comment, where no importer ever would", () => {
    const jsdoc = " * Same pure-state-ops shape as `@demlik/tea/idempotency`.";
    expect(closedDoorSpecifiers(jsdoc, allowed)).toEqual([
      "@demlik/tea/idempotency",
    ]);
  });

  it("passes a published subpath, the bare root, and a non-.ts subpath", () => {
    const prose =
      'import { memoryStore } from "@demlik/tea/mem"; // over @demlik/tea\n' +
      "plus `@demlik/tea/devtools/styles.css`";
    expect(closedDoorSpecifiers(prose, allowed)).toEqual([]);
  });

  it("does not swallow the period that ends a sentence", () => {
    expect(
      closedDoorSpecifiers(
        "the store ships on @demlik/tea/mem. The host wires it.",
        allowed,
      ),
    ).toEqual([]);
  });
});

describe("no tracked file names a closed door", () => {
  const allowed = publishedSpecifiers();

  it.each(scannedFiles())("%s", (file) => {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    expect(closedDoorSpecifiers(text, allowed)).toEqual([]);
  });
});
