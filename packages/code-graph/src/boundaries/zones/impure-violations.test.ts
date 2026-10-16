import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { crossingsOf, ledgerText } from "../../test-helpers/library-report.js";

const IMPURE = "impure";
const DRIVING = "src/orders/adapters/driving/http.ts";

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

// The `impure` entries a `--json` run lists: `[file below the scope, row]`.
function impureIn(files: Record<string, string>, rules: Record<string, unknown> = {}) {
  repo = apiRepo(files, rules);
  return crossingsOf(repo.run({ json: true }))
    .filter(([kind]) => kind === IMPURE)
    .map(([, from, row]) => [from?.slice(API.length + 1), row]);
}

describe("a hexagonal scope judges every row of IMPURE_GLOBALS in a zone that may not be impure", () => {
  it.each([
    ["console", 'export const x = () => console.log("x");\n'],
    ["fetch", 'export const x = () => fetch("https://example.test");\n'],
    ["Date.now", "export const x = Date.now();\n"],
    ["new Date()", "export const x = new Date();\n"],
    ["process.env", "export const x = process.env.MODE;\n"],
    ["node:fs", 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n'],
  ])("reports %s in a driving adapter", (row, source) => {
    expect(impureIn({ [DRIVING]: source })).toEqual([[DRIVING, row]]);
  });

  it("judges index.ts, ports.ts and application/ too, and one entry per file per row", () => {
    const body = "export const x = [console.log, console.warn, fetch, Date.now()];\n";
    const found = impureIn({
      [DRIVING]: body,
      "src/orders/index.ts": body,
      "src/orders/ports.ts": body,
      "src/orders/application/use.ts": body,
    });
    const files = [
      "src/orders/adapters/driving/http.ts",
      "src/orders/application/use.ts",
      "src/orders/index.ts",
      "src/orders/ports.ts",
    ];
    expect(found).toEqual(
      files.flatMap((file) => ["console", "Date.now", "fetch"].map((row) => [file, row])),
    );
  });

  it("leaves a type-only import of a module, and a name the file binds itself, clean", () => {
    expect(
      impureIn({
        [DRIVING]: 'import type { Stats } from "node:fs";\nexport type S = Stats;\n',
        "src/orders/adapters/driving/bound.ts":
          "export const x = (fetch: () => void, console: { log(): void }) => [fetch(), console.log()];\n",
      }),
    ).toEqual([]);
  });

  it("does not judge a place that may be impure: a driven adapter, a file in no feature, lib", () => {
    expect(
      impureIn({
        "src/orders/adapters/driven/db.ts": 'export const x = () => fetch("https://db.test");\n',
        "src/main.ts": "export const x = console.log;\n",
        "src/lib/clock.ts": "export const x = Date.now();\n",
      }),
    ).toEqual([]);
  });

  it("records an entry that still gates once it is accepted", () => {
    const files = { [DRIVING]: "export const x = [process.env.MODE, process.stdin.isTTY];\n" };
    expect(impureIn(files)).toEqual([
      [DRIVING, "process.env"],
      [DRIVING, "process.stdin"],
    ]);
    const run = repo as BoundaryRepo;
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const recorded = ledgerText(run);
    const gated = run.run({ ci: true });
    expect(gated.code).toBe(0);
    expect(gated.stdout).toContain("2 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(recorded);
  });
});
