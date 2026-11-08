import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import {
  INTERPRETER_CROSSINGS,
  INTERPRETER_FILES,
  INTERPRETER_RULES,
  INTERPRETER_RULES_WITHOUT_INTERPRETERS,
  MAIL,
  SHOP,
  TYPE_ONLY,
} from "../../test-helpers/shop-interpreters.js";
import { SHAPE_FILES, SHAPE_RULES } from "../../test-helpers/shop-shape.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import type { BoundaryViolation } from "../violation.js";

const B22 = "technology-outside-interpreter";
const B23 = "interpreter-imports-feature";

let repo: BoundaryRepo | null = null;
const open = (
  rules: unknown = INTERPRETER_RULES,
  files: Readonly<Record<string, string>> = INTERPRETER_FILES,
): BoundaryRepo => {
  repo = boundaryRepo(".", files, rules);
  return repo;
};
afterEach(() => repo?.dispose());

const violationsOf = (run: BoundaryRepo): { scope: string; violation: BoundaryViolation }[] =>
  reportOf(run.run({ json: true })).scopes.flatMap(({ scope, violations }) =>
    violations.map((violation) => ({ scope, violation })),
  );

// `[scope, kind, from, to ?? specifier]` of every crossing a `--json` run lists.
const listed = (run: BoundaryRepo): string[][] =>
  sorted(
    violationsOf(run).map(({ scope, violation }) => [
      scope,
      violation.kind,
      violation.from,
      ledgerTargetOf(violation),
    ]),
  );

describe("a team gives each technology one interpreter and holds the rule behind the merge gate", () => {
  it("lists exactly the nineteen files that keep a queue adapter, once each, in both layouts", () => {
    const run = open();
    expect(listed(run)).toEqual(sorted(INTERPRETER_CROSSINGS));
    const plain = run.run();
    expect(plain.code).toBe(0);
    expect(plain.stdout.match(/^ {2}B22 /gm)).toHaveLength(19);
    expect(plain.stdout).not.toContain("B23");
  });

  it("marks type-only only where every import of the file's queue modules is", () => {
    const run = open();
    const found = violationsOf(run).filter(({ scope }) => scope === SHOP);
    expect(found).toHaveLength(15);
    for (const { violation } of found) {
      const below = violation.from.replace(/^services\/shop\/src\/[^/]+\//, "");
      expect(violation.typeOnly, violation.from).toBe(TYPE_ONLY[below]);
    }
  });

  it("records them, gates green byte for byte, and prunes each as it is fixed", () => {
    const run = open();
    const failed = run.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(19);
    expect(failed.stdout).toContain("A technology has one interpreter.");
    expect(fs.existsSync(run.ledgerFile)).toBe(false);

    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(entries).toHaveLength(19);
    expect(entries.every((entry) => entry.reason === "legacy" && entry.to === null)).toBe(true);
    expect(sorted(entries.map((e) => [e.scope, e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
      sorted(INTERPRETER_CROSSINGS),
    );
    const seeded = ledgerText(run);
    const first = run.run({ ci: true });
    const second = run.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.stdout).toContain("19 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(seeded);

    // Moving the adapter into the interpreter prunes exactly its entry.
    run.put(`${SHOP}/src/orders/adapters/driven/jobs.ts`, "export const jobs = [];\n");
    const fixed = run.run({ ci: true });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(ledgerOf(run).entries).toHaveLength(18);
  });

  it("judges an adapter folder the layout has no zone for, and a technology only where a scope lists it", () => {
    const run = open();
    run.put(
      `${SHOP}/src/orders/adapters/legacy/queue.ts`,
      'import { enqueue } from "queue-sdk";\nexport const a = enqueue;\n',
    );
    const found = listed(run);
    expect(found).toContainEqual([
      SHOP,
      B22,
      `${SHOP}/src/orders/adapters/legacy/queue.ts`,
      "queue",
    ]);
    expect(found).toContainEqual([
      SHOP,
      "unknown-zone",
      `${SHOP}/src/orders/adapters/legacy`,
      "adapters/legacy",
    ]);
    repo?.dispose();

    const git = { git: { root: "src/interpreters/git", modules: ["simple-git"] } };
    const withGit = open(
      {
        ...INTERPRETER_RULES,
        interpreters: { [SHOP]: { ...INTERPRETER_RULES.interpreters[SHOP], ...git } },
      },
      { ...INTERPRETER_FILES, [`${SHOP}/src/interpreters/git/index.ts`]: "export {};\n" },
    );
    const gits = listed(withGit).filter((row) => row[3] === "git");
    expect(gits).toEqual(
      ["billing", "orders", "shipping"].map((feature) => [
        SHOP,
        B22,
        `${SHOP}/src/${feature}/adapters/driven/git.ts`,
        "git",
      ]),
    );
  });

  it("matches a path module by the file it resolves to, with its extension dropped or as a folder", () => {
    const files = {
      ...shopManifests([SHOP]),
      [`${SHOP}/src/lib/queue/send.ts`]: "export const send = 1;\n",
      [`${SHOP}/src/lib/queue/deep/retry.ts`]: "export const retry = 1;\n",
      [`${SHOP}/src/lib/queue-extra.ts`]: "export const extra = 1;\n",
      [`${SHOP}/src/lib/queue.ts`]: "export const queue = 1;\n",
      [`${SHOP}/src/orders/ports.ts`]: 'export { send } from "../lib/queue/send.js";\n',
      [`${SHOP}/src/billing/ports.ts`]: 'export { retry } from "../lib/queue/deep/retry";\n',
      [`${SHOP}/src/shipping/ports.ts`]: 'export { queue } from "../lib/queue";\n',
      [`${SHOP}/src/orders/adapters/driven/extra.ts`]:
        'export { extra } from "../../../lib/queue-extra";\n',
      [`${SHOP}/src/interpreters/queue/index.ts`]: "export {};\n",
    };
    const rules = {
      features: { [SHOP]: ["orders", "billing", "shipping"] },
      interpreters: {
        [SHOP]: { queue: { root: "src/interpreters/queue", modules: ["src/lib/queue"] } },
      },
    };
    expect(listed(open(rules, files))).toEqual(
      sorted(
        ["orders", "billing", "shipping"].map((feature) => [
          SHOP,
          B22,
          `${SHOP}/src/${feature}/ports.ts`,
          "queue",
        ]),
      ),
    );
  });
});

describe("a module two technologies of one scope list", () => {
  // `queue-sdk` is also the scheduler's module, so a file importing it keeps two technologies'
  // adapters. The queue alone lists the path module `src/lib/queue-client`.
  const SCHEDULER = { root: "src/interpreters/scheduler", modules: ["queue-sdk"] };
  const PORTS = `${SHOP}/src/orders/ports.ts`;
  const HTTP = `${SHOP}/src/orders/adapters/driving/http.ts`;
  const sharing = (): BoundaryRepo =>
    open(
      {
        ...INTERPRETER_RULES,
        interpreters: {
          ...INTERPRETER_RULES.interpreters,
          [SHOP]: { ...INTERPRETER_RULES.interpreters[SHOP], scheduler: SCHEDULER },
        },
      },
      { ...INTERPRETER_FILES, [`${SHOP}/src/interpreters/scheduler/index.ts`]: "export {};\n" },
    );
  const of = (rows: string[][], from: string): string[][] => rows.filter((row) => row[2] === from);

  it("is one entry per technology on a file that imports it, named by the technology", () => {
    const run = sharing();
    expect(of(listed(run), PORTS)).toEqual([
      [SHOP, B22, PORTS, "queue"],
      [SHOP, B22, PORTS, "scheduler"],
    ]);
    const entries = violationsOf(run)
      .map(({ violation }) => violation)
      .filter((violation) => violation.from === PORTS);
    expect(entries.map(({ specifier, to, typeOnly }) => [specifier, to, typeOnly])).toEqual([
      ["queue", null, true],
      ["scheduler", null, true],
    ]);
    // A file that imports only the module one technology lists is that technology's entry alone.
    expect(of(listed(run), HTTP)).toEqual([[SHOP, B22, HTTP, "queue"]]);
  });

  it("holds both entries in the ledger, and a gate that has them recorded stays green", () => {
    const run = sharing();
    expect(run.run({ ci: true }).code).toBe(1);
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const held = ledgerOf(run).entries.filter((entry) => entry.from === PORTS);
    expect(
      held.map((entry) => [entry.scope, entry.kind, entry.from, ledgerTargetOf(entry)]),
    ).toEqual([
      [SHOP, B22, PORTS, "queue"],
      [SHOP, B22, PORTS, "scheduler"],
    ]);
    const seeded = ledgerText(run);
    expect([run.run({ ci: true }).code, run.run({ ci: true }).code]).toEqual([0, 0]);
    expect(ledgerText(run)).toBe(seeded);
  });
});

describe("a library nested in the scope", () => {
  const ORDERS_LIBRARY = `${SHOP}/src/orders/adapters/driven/vendored`;
  const ROOT_LIBRARY = `${SHOP}/src/interpreters/queue/vendored`;
  const IN_ADAPTERS = `${ORDERS_LIBRARY}/send.ts`;
  const IN_ROOT = `${ROOT_LIBRARY}/boot.ts`;
  const FILES = {
    ...INTERPRETER_FILES,
    ...shopManifests([ORDERS_LIBRARY, ROOT_LIBRARY]),
    // The same imports a driven adapter of the feature makes, from inside the library.
    [IN_ADAPTERS]:
      'import { enqueue } from "queue-sdk";\nimport { client } from "../../../../lib/queue-client";\nexport const s = [enqueue, client];\n',
    // And the imports of a feature's `index.ts`, `application/` and adapter files B23 reports.
    [IN_ROOT]: [
      'import { place } from "../../../orders/index";',
      'import type { Place } from "../../../billing/application/place";',
      'export { jobs } from "../../../shipping/adapters/driven/jobs";',
      "export const b = place;",
      "",
    ].join("\n"),
  };
  const NESTED = {
    libraryTypes: { vendored: { imports: [], pure: false } },
    libraries: { [ORDERS_LIBRARY]: "vendored", [ROOT_LIBRARY]: "vendored" },
  };
  const rows = (rules: unknown, kind: string): string[][] =>
    listed(open(rules, FILES)).filter((row) => row[1] === kind);

  it("is left to the library's own scope, so its imports of a covered module are not B22", () => {
    // Undeclared, the folder is one of the feature's adapter folders and B22 judges it.
    expect(rows(INTERPRETER_RULES, B22)).toContainEqual([SHOP, B22, IN_ADAPTERS, "queue"]);
    repo?.dispose();
    // Declared, only the library's file drops out: the feature's own adapters are judged as before.
    expect(rows({ ...INTERPRETER_RULES, ...NESTED }, B22)).toEqual(sorted(INTERPRETER_CROSSINGS));
  });

  it("is still judged by B23 when it sits under an interpreter root, and B4 is not beside it", () => {
    const run = open({ ...INTERPRETER_RULES, ...NESTED }, FILES);
    const found = violationsOf(run).filter(({ violation }) => violation.from === IN_ROOT);
    expect(
      found.map(({ scope, violation }) => [scope, violation.kind, ledgerTargetOf(violation)]),
    ).toEqual(
      [
        `${SHOP}/src/billing/application/place.ts`,
        `${SHOP}/src/orders/index.ts`,
        `${SHOP}/src/shipping/adapters/driven/jobs.ts`,
      ].map((target) => [SHOP, B23, target]),
    );
  });
});

describe("an interpreter root imports no feature", () => {
  const ROOT = `${SHOP}/src/interpreters/queue`;
  const reaching = (extra: Record<string, string>): BoundaryRepo =>
    open(INTERPRETER_RULES, { ...INTERPRETER_FILES, ...extra });
  const b23 = (run: BoundaryRepo) =>
    violationsOf(run)
      .filter(({ violation }) => violation.kind === B23)
      .map(({ violation }) => violation);

  it("reports a feature's index, application and adapter file once per file and target, and no B4 beside it", () => {
    const run = reaching({
      [`${ROOT}/features.ts`]: [
        'import { enqueue } from "queue-sdk";',
        'import { place } from "../../orders/index";',
        'import type { Place } from "../../orders/index";',
        'import type { Job } from "../../billing/application/place";',
        'export { a } from "../../shipping/adapters/driven/jobs";',
        'export const lazy = () => import("../../orders/adapters/driving/http");',
        "export const x = [enqueue, place];",
        "",
      ].join("\n"),
    });
    const found = b23(run);
    expect(
      found
        .map((v) => [v.from, ledgerTargetOf(v), v.typeOnly])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual(
      [
        [`${ROOT}/features.ts`, `${SHOP}/src/billing/application/place.ts`, true],
        [`${ROOT}/features.ts`, `${SHOP}/src/orders/adapters/driving/http.ts`, false],
        [`${ROOT}/features.ts`, `${SHOP}/src/orders/index.ts`, false],
        [`${ROOT}/features.ts`, `${SHOP}/src/shipping/adapters/driven/jobs.ts`, false],
      ].sort(([, a], [, b]) => String(a).localeCompare(String(b))),
    );
    expect(
      violationsOf(run).some(
        ({ violation }) => violation.kind === "outside-imports-feature-internal",
      ),
    ).toBe(false);
    expect(listed(run)).toHaveLength(INTERPRETER_CROSSINGS.length + 4);
  });

  it("judges a test file the rules name, and leaves a lib file, a sibling and its own modules alone", () => {
    const run = reaching({
      [`${ROOT}/features.test.ts`]:
        'import { place } from "../../orders/index";\nexport const t = place;\n',
      [`${ROOT}/clean.ts`]: [
        'import { enqueue } from "queue-sdk";',
        'import { client } from "../../lib/queue-client";',
        'import { send } from "./index";',
        "export const x = [enqueue, client, send];",
        "",
      ].join("\n"),
    });
    expect(b23(run).map((v) => v.from)).toEqual([`${ROOT}/features.test.ts`]);
  });

  it("is judged in the port layout by the same code", () => {
    const run = reaching({
      [`${MAIL}/src/interpreters/queue/boot.ts`]:
        'import { send } from "../../application/send-mail";\nexport const s = send;\n',
    });
    expect(b23(run).map((v) => [v.from, ledgerTargetOf(v)])).toEqual([
      [`${MAIL}/src/interpreters/queue/boot.ts`, `${MAIL}/src/application/send-mail.ts`],
    ]);
  });
});

describe("an interpreter root is an adapter in every rule that reads the zone table", () => {
  const WORLD = [
    'import fs from "node:fs";',
    "export const read = (env: Env) => [fs, fetch, process.env, env.DB.prepare('SELECT 1')];",
    "",
  ].join("\n");
  const ROOT_WORLD = `${SHOP}/src/interpreters/queue/world.ts`;
  const READS = `${SHOP}/src/orders/adapters/driven/reads.ts`;
  const LIBRARIES = {
    libraryRoots: ["packages"],
    libraryTypes: {
      ...SHOP_TYPES,
      wiring: { imports: [], pure: false, importedFrom: ["configurator"] },
    },
    libraries: { "packages/clock-adapter": "adapter", "packages/boot-wiring": "wiring" },
  };
  const world = (rules: Record<string, unknown> = {}): BoundaryRepo =>
    open(
      { ...INTERPRETER_RULES, ...LIBRARIES, ...rules },
      {
        ...INTERPRETER_FILES,
        ...shopManifests(["packages/clock-adapter", "packages/boot-wiring"]),
        "packages/clock-adapter/src/index.ts": "export const clock = 1;\n",
        "packages/boot-wiring/src/index.ts": "export const boot = 1;\n",
        [`${SHOP}/wrangler.jsonc`]: JSON.stringify({
          name: "shop",
          d1_databases: [{ binding: "DB" }],
        }),
        [ROOT_WORLD]: `import { clock } from "@shop/clock-adapter";\nimport { boot } from "@shop/boot-wiring";\nexport const w = [clock, boot];\n${WORLD}`,
        [`${SHOP}/src/shipping/ports.ts`]: WORLD,
        [`${SHOP}/src/billing/application/world.ts`]: WORLD,
        [READS]: WORLD,
      },
    );
  const crossingsIn = (run: BoundaryRepo, kind: string): string[] =>
    violationsOf(run)
      .filter(({ violation }) => violation.kind === kind)
      .map(({ violation }) => `${violation.from} ${violation.specifier}`)
      .sort();

  it("may be impure, where the same use in a feature's ports.ts is B7", () => {
    const impure = crossingsIn(world(), "impure");
    expect(impure.some((row) => row.startsWith(ROOT_WORLD))).toBe(false);
    expect(impure.some((row) => row.startsWith(`${SHOP}/src/shipping/ports.ts`))).toBe(true);
  });

  it("may use a worker binding, and a binding owner may be a file under the root", () => {
    const listedKinds = { acrossDeployables: ["binding-outside-driven-adapter"] };
    // The same use in `application/` and in `ports.ts` is B17; the root and a driven adapter are not.
    const elsewhere = [
      `${SHOP}/src/billing/application/world.ts DB`,
      `${SHOP}/src/shipping/ports.ts DB`,
    ];
    expect(crossingsIn(world(listedKinds), "binding-outside-driven-adapter")).toEqual(elsewhere);

    // An owner list narrows the driven adapters to the files it names, and the root file may be one.
    const owned = world({
      ...listedKinds,
      bindingOwners: { [SHOP]: { DB: ["src/interpreters/queue/world.ts"] } },
    });
    expect(owned.run({ ci: true }).errors).toEqual([]);
    expect(crossingsIn(owned, "binding-outside-driven-adapter")).toEqual(
      [...elsewhere, `${READS} DB`].sort(),
    );
  });

  it("satisfies a library that lists the driven zone, and breaks one that lists only the configurator", () => {
    const found = violationsOf(world())
      .filter(({ violation }) => violation.kind === "adapter-library-imported-outside-driven")
      .map(({ violation }) => [violation.from, ledgerTargetOf(violation)]);
    expect(found).toEqual([[ROOT_WORLD, "packages/boot-wiring"]]);
  });

  it("names the root beside the driven zone when it refuses an owner that is under neither", () => {
    const run = world({
      acrossDeployables: ["binding-outside-driven-adapter"],
      bindingOwners: { [SHOP]: { DB: ["src/billing/application/world.ts"] } },
    });
    const refused = run.run({ ci: true });
    expect(refused.code).toBe(2);
    expect(refused.errors).toEqual([
      expect.stringContaining(
        "or an interpreter root (src/interpreters/queue/): only a driven adapter may use a binding",
      ),
    ]);
  });
});

describe("a rules file without interpreters runs as it did", () => {
  it("gives the same report, ledger and keys for no key and for an empty one", () => {
    for (const [files, rules] of [
      [INTERPRETER_FILES, INTERPRETER_RULES_WITHOUT_INTERPRETERS],
      [SHAPE_FILES, SHAPE_RULES],
    ] as const) {
      const bytes = (extra: object) => {
        const run = open({ ...rules, ...extra }, files);
        const json = run.run({ json: true });
        const plain = run.run();
        const accepted = run.run({ acceptCrossings: true, reason: "legacy" });
        const gated = run.run({ ci: true, json: true });
        const ledger = fs.existsSync(run.ledgerFile) ? ledgerText(run) : "";
        const out = [json.stdout, plain.stdout, accepted.stdout, gated.stdout, ledger];
        repo?.dispose();
        return out;
      };
      const without = bytes({});
      expect(bytes({ interpreters: {} })).toEqual(without);
      expect(Object.keys(JSON.parse(without[0] ?? "{}"))).not.toContain("interpreters");
    }
  });

  it("reports nothing of B22 or B23 for the queue files when no scope lists them", () => {
    const kinds = new Set(
      listed(open(INTERPRETER_RULES_WITHOUT_INTERPRETERS)).map(([, kind]) => kind),
    );
    expect(kinds.has(B22) || kinds.has(B23)).toBe(false);
  });
});
