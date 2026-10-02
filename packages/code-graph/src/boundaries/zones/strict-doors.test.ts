import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { crossingsOf, ledgerText } from "../../test-helpers/library-report.js";

const B9 = "door-outside-driven-adapter";
const DRIVING = "src/orders/adapters/driving/http.ts";
const STRICT = { strictDriving: [API] };

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

// The B9 entries a `--json` run lists: `[file below the scope, door]`.
function doorsIn(files: Record<string, string>, rules: Record<string, unknown> = STRICT) {
  repo = apiRepo(files, rules);
  return crossingsOf(repo.run({ json: true }))
    .filter(([kind]) => kind === B9)
    .map(([, from, door]) => [from?.slice(API.length + 1), door]);
}

describe("strictDriving makes B9 judge every catalog door, declared or not", () => {
  it.each([
    ["console", 'export const x = () => console.log("x");\n'],
    ["fetch", 'export const x = () => fetch("https://example.test");\n'],
    ["Date.now", "export const x = Date.now();\n"],
    ["new Date()", "export const x = new Date();\n"],
    ["process.env", "export const x = process.env.MODE;\n"],
    ["node:fs", 'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n'],
  ])("flips %s in a driving adapter from clean to B9", (door, source) => {
    expect(doorsIn({ [DRIVING]: source }, {})).toEqual([]);
    repo?.dispose();
    expect(doorsIn({ [DRIVING]: source })).toEqual([[DRIVING, door]]);
  });

  it("judges index.ts and ports.ts too, and one entry per file per door", () => {
    const body = "export const x = [console.log, console.warn, fetch, Date.now()];\n";
    expect(
      doorsIn({
        [DRIVING]: body,
        "src/orders/index.ts": body,
        "src/orders/ports.ts": body,
        "src/orders/application/use.ts": body,
      }),
    ).toEqual([
      ["src/orders/adapters/driving/http.ts", "console"],
      ["src/orders/adapters/driving/http.ts", "Date.now"],
      ["src/orders/adapters/driving/http.ts", "fetch"],
      ["src/orders/index.ts", "console"],
      ["src/orders/index.ts", "Date.now"],
      ["src/orders/index.ts", "fetch"],
      ["src/orders/ports.ts", "console"],
      ["src/orders/ports.ts", "Date.now"],
      ["src/orders/ports.ts", "fetch"],
    ]);
  });

  it("leaves a type-only import of a module door, and a name the file binds itself, clean", () => {
    expect(
      doorsIn({
        [DRIVING]: 'import type { Stats } from "node:fs";\nexport type S = Stats;\n',
        "src/orders/adapters/driving/bound.ts":
          "export const x = (fetch: () => void, console: { log(): void }) => [fetch(), console.log()];\n",
      }),
    ).toEqual([]);
  });

  it("does not judge a zone B9 does not claim: driven adapters stay B5's", () => {
    expect(
      doorsIn({
        "src/orders/adapters/driven/db.ts": 'export const x = () => fetch("https://db.test");\n',
        "src/main.ts": "export const x = console.log;\n",
      }),
    ).toEqual([]);
  });

  it("is off for a scope it does not name, and without the key", () => {
    const source = "export const x = console.log;\n";
    expect(doorsIn({ [DRIVING]: source }, { strictDriving: [] })).toEqual([]);
    repo?.dispose();
    const rules = {
      features: { [API]: ["orders"], "services/other": ["x"] },
      layout: { [API]: "hexagonal", "services/other": "hexagonal" },
      strictDriving: ["services/other"],
    };
    expect(doorsIn({ [DRIVING]: source }, rules)).toEqual([]);
  });

  it("keeps the entry of a declared door, so a recorded B9 entry still gates", () => {
    const owner = "src/orders/adapters/driven/env.ts";
    const files = {
      [owner]: "export const mode = process.env.MODE;\n",
      [DRIVING]: "export const x = [process.env.MODE, process.stdin.isTTY];\n",
    };
    const doors = { [API]: { "process.env": [owner], "process.stdin.isTTY": [owner] } };
    expect(doorsIn(files, { doors })).toEqual([
      [DRIVING, "process.env"],
      [DRIVING, "process.stdin.isTTY"],
    ]);
    const run = repo as BoundaryRepo;
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const recorded = ledgerText(run);
    const strict = path.join(run.root, "strict.json");
    const rules = { features: { [API]: ["orders", "billing"] }, layout: { [API]: "hexagonal" } };
    fs.writeFileSync(strict, JSON.stringify({ ...rules, doors, ...STRICT }));
    const gated = run.run({ ci: true, rules: strict });
    expect(gated.code).toBe(0);
    expect(gated.stdout).toContain("2 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(recorded);
  });

  it("names an undeclared door by the catalog beside a declared one", () => {
    const files = {
      [DRIVING]: "export const x = [process.env.MODE, process.hrtime(), console.log];\n",
    };
    const doors = { [API]: { "process.env": ["src/orders/adapters/driven/env.ts"] } };
    const driven = { "src/orders/adapters/driven/env.ts": "export const m = process.env.MODE;\n" };
    expect(doorsIn({ ...files, ...driven }, { doors, ...STRICT })).toEqual([
      [DRIVING, "console"],
      [DRIVING, "process.env"],
      [DRIVING, "process.hrtime"],
    ]);
  });
});
