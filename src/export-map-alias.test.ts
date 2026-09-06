// ═══════════════════════════════════════════════════════════════════════════
// THE TEST RUNNER RESOLVES THE PUBLISHED SPECIFIER — every door, not most.
//
// `examples/*.ts` import `@demlik/tea/…`, and tests import the published
// specifier directly, so `vitest.config.ts` aliases it back at `src/`. That
// alias used to be a GUESS — `@demlik/tea/(.*)` → `src/$1/index.ts` — which is
// right for most doors and wrong for a flat module or for the one subpath that
// is not a module at all (`devtools/styles.css`). Nothing imported those
// through the specifier yet, so the breakage was latent: the FIRST test or
// example to do so would have died with a module-not-found naming a directory
// that never existed.
//
// The alias is now DERIVED from `package.json`'s `exports`, and this file is
// the check that the derivation resolves — for EVERY module door, read off the
// map rather than from a list kept beside it. The closing sweep (#51) removed
// the flat modules this file used to name one at a time
// (`extension/react`, `extension/test-utils`); reading the map instead means
// the next shape change is covered without editing the cases.
//
// The bare-root import is STATIC on purpose: a broken root alias then fails at
// COLLECT time, which is the failure mode a consumer would actually hit.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineMachine } from "@demlik/tea";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every module door: the subpaths whose target is JavaScript. */
function moduleDoors(): string[] {
  const { exports: map } = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, string | { import?: string }> };
  return Object.entries(map)
    .filter(([spec, entry]) => {
      if (spec === "." || spec === "./package.json") return false;
      const dist = typeof entry === "string" ? entry : entry.import;
      return dist?.endsWith(".js") === true;
    })
    .map(([spec]) => spec.slice(2));
}

describe("every published door resolves under the test alias", () => {
  it("resolves the bare root", () => {
    expect(typeof defineMachine).toBe("function");
  });

  it.each(moduleDoors())("@demlik/tea/%s", async (sub) => {
    // `@vite-ignore`: the specifier is computed from the export map, so vite's
    // dynamic-import-vars analysis cannot enumerate it and warns. The alias is
    // applied at resolve time either way — which is exactly what this asserts.
    const mod = (await import(
      /* @vite-ignore */ `@demlik/tea/${sub}`
    )) as Record<string, unknown>;
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
