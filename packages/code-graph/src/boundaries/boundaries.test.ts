import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBoundaryRules } from "../config.js";
import type { BoundaryViolation } from "./analyze.js";
import { runBoundaryGate } from "./gate.js";
import { CEILINGS_FILENAME } from "./rules.js";

const SCOPE = "services/svc";

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
    include: ["src"],
  }),
  "src/audit-runs/index.ts": "export { save } from './store/db.js';\n",
  "src/audit-runs/store/db.ts": "export const save = 1;\n",
  "src/findings/index.ts": "export { run } from './flows/run.js';\n",
  "src/findings/store/repo.ts": "export const repo = 1;\n",
  "src/findings/flows/run.ts": [
    "import { save } from '../../audit-runs/index.js';",
    "import { save as raw } from '../../audit-runs/store/db.js';",
    "import { repo } from '../store/repo.js';",
    "export const run = save + raw + repo;",
  ].join("\n"),
  "src/findings/rules/helper.ts": "export const helper = 1;\n",
  "src/findings/rules/score.ts": [
    "import { helper } from './helper.js';",
    "import type { Wire } from '@acme/wire-contract';",
    "import { repo } from '../store/repo.js';",
    "import { z } from 'zod';",
    "export const score = helper + repo;",
    "export type W = Wire | typeof z;",
  ].join("\n"),
  "src/lib/util.ts": "import { run } from '../findings/index.js';\nexport const util = run;\n",
  "src/index.ts": "import { repo } from './findings/store/repo.js';\nexport const entry = repo;\n",
};

let repoRoot = "";
let rulesFile = "";

function write(rel: string, body: string): void {
  const file = path.join(repoRoot, SCOPE, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-boundaries-"));
  for (const [rel, body] of Object.entries(FILES)) write(rel, body);
  rulesFile = path.join(repoRoot, "boundaries.json");
  fs.writeFileSync(
    rulesFile,
    JSON.stringify({
      features: { [SCOPE]: ["audit-runs", "findings"] },
      lib: ["lib"],
      contracts: ["@acme/wire-contract"],
    }),
  );
});
afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

function run(over: { ci?: boolean; writeCeilings?: boolean; json?: boolean; rules?: string }) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = runBoundaryGate({
    rootAbsolute: path.join(repoRoot, SCOPE),
    repoRoot,
    boundaryRulesFile: over.rules ?? rulesFile,
    ci: over.ci === true,
    writeCeilings: over.writeCeilings === true,
    emit: (payload) => {
      out.push(payload);
    },
    report: (message) => {
      errors.push(message);
    },
    json: over.json === true,
    pretty: false,
  });
  return { code, stdout: out.join(""), errors };
}

function violations(): BoundaryViolation[] {
  const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(
    run({ json: true }).stdout,
  );
  return parsed.scopes.flatMap((s) => s.violations);
}

describe("analyzeBoundaries over a real fixture's import edges", () => {
  it("reports each kind once, at the edge that crosses", () => {
    expect(violations().map((v) => [v.kind, v.from, v.specifier])).toEqual([
      ["cross-feature", "services/svc/src/findings/flows/run.ts", "../../audit-runs/store/db.js"],
      ["impure-rules", "services/svc/src/findings/rules/score.ts", "../store/repo.js"],
      ["impure-rules", "services/svc/src/findings/rules/score.ts", "zod"],
      ["lib-imports-feature", "services/svc/src/lib/util.ts", "../findings/index.js"],
      ["outside-imports-feature-internal", "services/svc/src/index.ts", "./findings/store/repo.js"],
    ]);
  });

  it("allows another feature's index.ts, the same feature, rules/ siblings and contracts", () => {
    const found = violations();
    const specifiers = found.map((v) => v.specifier);
    expect(specifiers).not.toContain("../../audit-runs/index.js");
    expect(found.filter((v) => v.from.endsWith("flows/run.ts"))).toHaveLength(1);
    expect(specifiers).not.toContain("./helper.js");
    expect(specifiers).not.toContain("@acme/wire-contract");
  });

  it("judges a file outside every feature and lib: a feature's internal file is B4", () => {
    expect(violations().filter((v) => v.from.endsWith("svc/src/index.ts"))).toEqual([
      {
        kind: "outside-imports-feature-internal",
        from: "services/svc/src/index.ts",
        to: "services/svc/src/findings/store/repo.ts",
        toFeature: "findings",
        specifier: "./findings/store/repo.js",
        typeOnly: false,
      },
    ]);
  });

  it("renders the human view one line per violation, tagged with its rule", () => {
    const { code, stdout } = run({});
    expect(code).toBe(0);
    expect(stdout).toContain("services/svc — features: audit-runs, findings");
    expect(stdout).toContain(
      "B1 cross-feature       services/svc/src/findings/flows/run.ts -> services/svc/src/audit-runs/store/db.ts",
    );
    expect(stdout).toContain(
      "B2 impure-rules        services/svc/src/findings/rules/score.ts -> zod",
    );
    expect(stdout).toContain(
      "B4 outside-imports-feature-internal services/svc/src/index.ts -> services/svc/src/findings/store/repo.ts" +
        '  ("./findings/store/repo.js")',
    );
  });

  it("reports nothing when no scope declares features", () => {
    const empty = path.join(repoRoot, "empty.json");
    fs.writeFileSync(empty, "{}");
    const { code, stdout } = run({ rules: empty });
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to check");
  });
});

describe("the boundary ratchet grandfathers today's count and only lets it fall", () => {
  const ceilingsFile = () => path.join(repoRoot, CEILINGS_FILENAME);
  const record = (count: number) =>
    fs.writeFileSync(ceilingsFile(), JSON.stringify({ default: 0, scopes: { [SCOPE]: count } }));

  it("records the measured count and then passes on it", () => {
    expect(run({ writeCeilings: true }).code).toBe(0);
    const recorded: { scopes: Record<string, number> } = JSON.parse(
      fs.readFileSync(ceilingsFile(), "utf8"),
    );
    expect(recorded.scopes[SCOPE]).toBe(5);
    const { code, stdout } = run({ ci: true });
    expect(code).toBe(0);
    expect(stdout).toContain("boundary ratchet: PASS");
  });

  it("fails EXCEEDED when a new crossing lands above the ceiling", () => {
    record(4);
    const { code, stdout } = run({ ci: true });
    expect(code).toBe(1);
    expect(stdout).toContain("EXCEEDED");
  });

  it("fails SLACK when a fixed crossing leaves the ceiling above reality", () => {
    record(6);
    const { code, stdout } = run({ ci: true });
    expect(code).toBe(1);
    expect(stdout).toContain("SLACK");
  });
});

describe("B4 judges an importer outside every declared feature and every lib folder", () => {
  const OUTSIDE_SCOPE = "apps/web";
  const OUTSIDE_FILES: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
      include: ["src", "scripts"],
    }),
    "src/billing/index.ts": "export { charge } from './flows/charge.js';\n",
    "src/billing/flows/charge.ts":
      "import { price } from '../rules/price.js';\nexport const charge = price;\n",
    "src/billing/rules/price.ts": "export const price = 1;\n",
    "src/billing/store/ledger.ts": "export const ledger = 1;\n",
    "src/main.ts": [
      "import { charge } from './billing/index.js';",
      "import { ledger } from './billing/store/ledger.js';",
      "import { price } from './billing/rules/price.js';",
      "export const main = charge + ledger + price;",
    ].join("\n"),
    "src/lib/clock.ts":
      "import { ledger } from '../billing/store/ledger.js';\nexport const clock = ledger;\n",
    "scripts/seed.ts":
      "import { ledger } from '../src/billing/store/ledger.js';\nexport const seed = ledger;\n",
  };
  let outsideRoot = "";
  let outsideRules = "";

  const put = (rel: string, body: string) => {
    const file = path.join(outsideRoot, OUTSIDE_SCOPE, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const gate = (over: { ci?: boolean; writeCeilings?: boolean; json?: boolean }) => {
    const out: string[] = [];
    const code = runBoundaryGate({
      rootAbsolute: path.join(outsideRoot, OUTSIDE_SCOPE),
      repoRoot: outsideRoot,
      boundaryRulesFile: outsideRules,
      ci: over.ci === true,
      writeCeilings: over.writeCeilings === true,
      emit: (payload) => {
        out.push(payload);
      },
      report: () => {},
      json: over.json === true,
      pretty: false,
    });
    return { code, stdout: out.join("") };
  };
  const found = (): BoundaryViolation[] => {
    const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(
      gate({ json: true }).stdout,
    );
    return parsed.scopes.flatMap((s) => s.violations);
  };

  beforeAll(() => {
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cg-boundaries-b4-"));
    for (const [rel, body] of Object.entries(OUTSIDE_FILES)) put(rel, body);
    outsideRules = path.join(outsideRoot, "boundaries.json");
    fs.writeFileSync(outsideRules, JSON.stringify({ features: { [OUTSIDE_SCOPE]: ["billing"] } }));
  });
  afterAll(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));

  it("allows the feature's index.ts and flags every other file, rules/ included, once per edge", () => {
    expect(found().map((v) => [v.kind, v.from, v.specifier])).toEqual([
      ["lib-imports-feature", "apps/web/src/lib/clock.ts", "../billing/store/ledger.js"],
      [
        "outside-imports-feature-internal",
        "apps/web/scripts/seed.ts",
        "../src/billing/store/ledger.js",
      ],
      ["outside-imports-feature-internal", "apps/web/src/main.ts", "./billing/rules/price.js"],
      ["outside-imports-feature-internal", "apps/web/src/main.ts", "./billing/store/ledger.js"],
    ]);
    expect(found().map((v) => v.specifier)).not.toContain("./billing/index.js");
  });

  it("leaves a lib importer to B3 alone", () => {
    expect(found().filter((v) => v.from.endsWith("src/lib/clock.ts"))).toEqual([
      {
        kind: "lib-imports-feature",
        from: "apps/web/src/lib/clock.ts",
        to: "apps/web/src/billing/store/ledger.ts",
        toFeature: "billing",
        specifier: "../billing/store/ledger.js",
        typeOnly: false,
      },
    ]);
  });

  it("counts B4 in the scope's ceiling: recorded, passing, then EXCEEDED by one more edge", () => {
    expect(gate({ writeCeilings: true }).code).toBe(0);
    const recorded: { scopes: Record<string, number> } = JSON.parse(
      fs.readFileSync(path.join(outsideRoot, CEILINGS_FILENAME), "utf8"),
    );
    expect(recorded.scopes[OUTSIDE_SCOPE]).toBe(4);
    expect(gate({ ci: true }).code).toBe(0);

    put(
      "src/extra.ts",
      "import { ledger } from './billing/store/ledger.js';\nexport const extra = ledger;\n",
    );
    const { code, stdout } = gate({ ci: true });
    expect(code).toBe(1);
    expect(stdout).toContain("EXCEEDED");
  });
});

describe("the boundary declaration is parsed at the config boundary", () => {
  it("ships an empty feature map and no contract packages by default", () => {
    const defaults = resolveBoundaryRules(undefined, () => {});
    expect(defaults?.features).toEqual({});
    expect(defaults?.contracts).toEqual([]);
  });

  it("refuses a folder declared as both a feature and lib, or a path as a feature", () => {
    const errors: string[] = [];
    const both = path.join(repoRoot, "both.json");
    fs.writeFileSync(both, JSON.stringify({ features: { [SCOPE]: ["lib"] } }));
    expect(resolveBoundaryRules(both, (m) => errors.push(m))).toBeNull();
    const nested = path.join(repoRoot, "nested.json");
    fs.writeFileSync(nested, JSON.stringify({ features: { [SCOPE]: ["a/b"] } }));
    expect(resolveBoundaryRules(nested, (m) => errors.push(m))).toBeNull();
    expect(errors).toHaveLength(2);
  });
});
