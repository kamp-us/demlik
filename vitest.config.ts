import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const abs = (p: string): string =>
  fileURLToPath(new URL(`./${p}`, import.meta.url));

type ExportEntry = string | { readonly import?: string };

/**
 * The published export map, re-pointed at `src/`.
 *
 * `@demlik/tea/x` → `src/x/index.ts` is TRUE for most subpaths and FALSE for
 * six of them — `extension/react`, `extension/test-utils`, `work-queue/ops`,
 * `work-queue/adapter`, `idempotency/adapter` are flat modules
 * (`src/extension/react.ts`), and `devtools/styles.css` is not a module at all.
 * Guessing the shape resolves five of those to a directory that does not exist
 * and the sixth to a `.ts` file that is a stylesheet, so the first test to
 * import one dies with a module-not-found for a reason nothing in the test
 * explains.
 *
 * So the map is not guessed: it is READ. `package.json`'s `exports` already
 * states, per subpath, exactly which file the specifier means; the only
 * transform is `dist/` → `src/` and `.js` → the source extension that actually
 * exists (`.ts`, or `.tsx` for `extension/react`); a non-JS target — the CSS —
 * is taken verbatim. That makes the alias table a derivation of the export map
 * rather than a second, drifting copy of it — a new subpath is aliased the
 * moment it is exported, in whichever shape it was exported.
 */
const pkg = JSON.parse(readFileSync(abs("package.json"), "utf8")) as {
  exports: Readonly<Record<string, ExportEntry>>;
};

const target = (entry: ExportEntry): string | undefined => {
  const dist = typeof entry === "string" ? entry : entry.import;
  if (dist === undefined || !dist.startsWith("./dist/")) return undefined;
  const from = dist.slice("./dist/".length);
  if (!from.endsWith(".js")) return abs(`src/${from}`);
  const stem = `src/${from.slice(0, -".js".length)}`;
  const found = [".ts", ".tsx"].map((x) => abs(stem + x)).find(existsSync);
  if (found === undefined) {
    throw new Error(
      `vitest.config: exports maps "${dist}", but neither ${stem}.ts nor ${stem}.tsx exists`,
    );
  }
  return found;
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest subpath first: `/^@demlik\/tea\/extension$/` must not shadow
// `@demlik/tea/extension/react`. Exact-match anchors make that moot, but the
// ordering is kept so an added prefix pattern cannot quietly reorder into a
// shadow.
const subpathAliases = Object.entries(pkg.exports)
  .filter(([spec]) => spec !== "." && spec !== "./package.json")
  .map(([spec, entry]) => [spec.slice(2), target(entry)] as const)
  .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
  .sort(([a], [b]) => b.length - a.length)
  .map(([sub, file]) => ({
    find: new RegExp(`^@demlik/tea/${escape(sub)}$`),
    replacement: file,
  }));

// Pure-module test runner. New behavior modules (retry-backoff, rate-limit,
// circuit-breaker, idempotency, deadline, cache, debounce, throttle,
// recorder, trace-replay, machine-viz) are host-agnostic and test in plain
// node — no happy-dom, no Workers pool. Test files are excluded from the
// published tarball (package.json `files: ["dist"]`) and from `tsc`/`tsup`.
export default defineConfig({
  // `src/chart/equiv-*.test.ts` drive the REAL `examples/*.ts` machines against
  // their chart ports, and those examples import the PUBLISHED specifier. Point
  // it at `src/` so the suite needs no prior `pnpm build` — and so both sides of
  // the equivalence run on the same substrate rather than one on dist and one
  // on source. Nothing under `src/` imports `@demlik/tea`, so no other test is
  // affected.
  resolve: {
    alias: [
      { find: /^@demlik\/tea$/, replacement: abs("src/index.ts") },
      ...subpathAliases,
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Pin fast-check's seed + raise numRuns so the property suite is
    // reproducible and deeper — no random-seed intermittent reds. See
    // `src/test-setup.ts`.
    setupFiles: ["./src/test-setup.ts"],
  },
});
