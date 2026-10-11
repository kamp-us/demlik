/**
 * The published-API ratchet — one file, two modes keyed on `TEA_API_BASE`:
 *
 *   - TEA_API_BASE=<rev> → the check (`pnpm run api:ratchet`, CI on a pull
 *     request): diff the working tree's published API against that commit and
 *     fail naming every change that misses the changeset its tier asks for.
 *   - unset → the mechanism proofs: the API map covers the export map and
 *     refuses a subpath it cannot place, and the policy gives each tier and
 *     change kind the verdict `MAINTAINING.md` states.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiDiff,
  ApiMapSchema,
  type Changeset,
  ratchetApiDiff,
} from "@demlik/code-graph/api";
import { describe, expect, it } from "vitest";
import { TIERS, type Tier } from "../docs/reference/tier-table";
import { buildApiMap, PKG_ROOT, readApiMap } from "./api-map";
import { TEA_BUMP_POLICY } from "./policy";
import { changeCount, renderVerdict, runApiRatchet } from "./ratchet";

const BASE = process.env.TEA_API_BASE;

const BEFORE = {
  text: "export declare function expectCmdEmitted<T>(actual: readonly T[], expected: NoInfer<T>): void;",
  references: {},
};
const AFTER = {
  text: "export declare function expectCmdEmitted<T>(actual: readonly T[], expected: T): void;",
  references: {},
};

type Kind = "added" | "changed" | "removed";

/** A diff reporting one change to one name, on a subpath of the given tier. */
const oneChange = (tier: Tier, kind: Kind): ApiDiff => ({
  root: ".",
  base: "0123456789abcdef0123456789abcdef01234567",
  compiler: "test",
  subpaths: {
    "./testing": {
      tier,
      added: kind === "added" ? { expectCmdEmitted: { after: AFTER } } : {},
      changed:
        kind === "changed"
          ? { expectCmdEmitted: { before: BEFORE, after: AFTER } }
          : {},
      removed:
        kind === "removed" ? { expectCmdEmitted: { before: BEFORE } } : {},
    },
  },
});

const changeset = (bump: Changeset["bump"], body: string): Changeset => ({
  file: ".changeset/a.md",
  bump,
  body,
});

const judge = (tier: Tier, kind: Kind, changesets: readonly Changeset[]) =>
  ratchetApiDiff(oneChange(tier, kind), TEA_BUMP_POLICY, {
    package: "@demlik/tea",
    changesets,
  });

const CALLOUT = "**Breaking:** `expected` is no longer pinned.";
const PLAIN = "Add `expectCmdEmitted`.";

describe.runIf(BASE === undefined)("api map", () => {
  const tiers = new Map<string, Tier>([
    [".", "stable"],
    ["./labs", "experimental"],
  ]);
  const entries = { index: "src/index.ts", "labs/index": "src/labs/index.ts" };

  it("joins each subpath to its tsup source and its tier", () => {
    const map = buildApiMap({
      exports: {
        ".": { import: "./dist/index.js" },
        "./labs": "./dist/labs/index.js",
        "./labs/styles.css": "./dist/labs/styles.css",
        "./package.json": "./package.json",
      },
      entries,
      outDir: "dist",
      tiers,
    });
    expect(map).toEqual({
      ".": { entry: "src/index.ts", tier: "stable" },
      "./labs": { entry: "src/labs/index.ts", tier: "experimental" },
    });
  });

  it("fails naming a subpath with no tier row", () => {
    expect(() =>
      buildApiMap({
        exports: {
          ".": { import: "./dist/index.js" },
          "./new": { import: "./dist/new/index.js" },
        },
        entries: { ...entries, "new/index": "src/new/index.ts" },
        outDir: "dist",
        tiers,
      }),
    ).toThrow("./new has no row in MAINTAINING.md's tier table");
  });

  it("fails naming a subpath no tsup entry builds", () => {
    expect(() =>
      buildApiMap({
        exports: { "./labs": { import: "./dist/labs.js" } },
        entries,
        outDir: "dist",
        tiers,
      }),
    ).toThrow("./labs has no entry in tsup.config.ts that builds its target");
  });

  it("covers every subpath tea exports, each with a source file that exists", () => {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    const exported = Object.keys(pkg.exports).filter(
      (s) => s !== "./package.json" && !s.endsWith(".css"),
    );
    const map = readApiMap();

    expect(Object.keys(map).sort()).toEqual(exported.sort());
    expect(ApiMapSchema.safeParse(map).success).toBe(true);
    for (const { entry } of Object.values(map)) {
      expect(existsSync(join(PKG_ROOT, entry)), entry).toBe(true);
    }
    expect(map["./testing"]).toEqual({
      entry: "src/testing/index.ts",
      tier: "stable",
    });
  });
});

describe.runIf(BASE === undefined)("bump policy", () => {
  it.each([
    "stable",
    "battery",
  ] as const)("a %s change or removal needs a minor with the breaking callout", (tier) => {
    for (const kind of ["changed", "removed"] as const) {
      expect(judge(tier, kind, []).passed).toBe(false);
      expect(judge(tier, kind, [changeset("minor", PLAIN)]).passed).toBe(false);
      expect(judge(tier, kind, [changeset("patch", CALLOUT)]).passed).toBe(
        false,
      );
      expect(judge(tier, kind, [changeset("minor", CALLOUT)]).passed).toBe(
        true,
      );
    }
  });

  it.each([
    "stable",
    "battery",
  ] as const)("a name added to a %s subpath needs a minor and no callout", (tier) => {
    expect(judge(tier, "added", []).passed).toBe(false);
    expect(judge(tier, "added", [changeset("patch", PLAIN)]).passed).toBe(
      false,
    );
    expect(judge(tier, "added", [changeset("minor", PLAIN)]).passed).toBe(true);
  });

  it("an experimental change of any kind needs a changeset of any bump", () => {
    for (const kind of ["added", "changed", "removed"] as const) {
      expect(judge("experimental", kind, []).passed).toBe(false);
      expect(
        judge("experimental", kind, [changeset("patch", PLAIN)]).passed,
      ).toBe(true);
    }
  });

  it("gives every tier of the tier table a row", () => {
    expect(Object.keys(TEA_BUMP_POLICY.tiers).sort()).toEqual(
      [...TIERS].sort(),
    );
  });
});

describe.runIf(BASE === undefined)("verdict text", () => {
  it("names the name, subpath, tier and the before and after text of a miss", () => {
    const diff = oneChange("stable", "changed");
    const text = renderVerdict(
      judge("stable", "changed", []),
      changeCount(diff),
      TEA_BUMP_POLICY.callout,
    );

    expect(text).toBe(
      [
        'api-ratchet: expectCmdEmitted in ./testing (stable) changed — needs a minor changeset with a "**Breaking" callout; found no changeset',
        "  before:",
        `    ${BEFORE.text}`,
        "  after:",
        `    ${AFTER.text}`,
        "api-ratchet: 1 of 1 published name changed against 0123456 without the changeset MAINTAINING.md's semver policy asks for — add one with `pnpm changeset`",
        "",
      ].join("\n"),
    );
  });

  it("prints a type the name uses only when its text moved", () => {
    const make = "export declare function make(options: Options): Store;";
    const diff: ApiDiff = {
      ...oneChange("stable", "changed"),
      subpaths: {
        "./mem": {
          tier: "stable",
          added: {},
          removed: {},
          changed: {
            make: {
              before: {
                text: make,
                references: {
                  "src/mem.d.ts#Options": "type Options = { fenced?: true };",
                  "src/mem.d.ts#Store": "type Store = { load(): void };",
                },
              },
              after: {
                text: make,
                references: {
                  "src/mem.d.ts#Options":
                    "type Options = { fenced?: boolean };",
                  "src/mem.d.ts#Store": "type Store = { load(): void };",
                },
              },
            },
          },
        },
      },
    };
    const verdict = ratchetApiDiff(diff, TEA_BUMP_POLICY, {
      package: "@demlik/tea",
      changesets: [],
    });

    const text = renderVerdict(verdict, 1, TEA_BUMP_POLICY.callout);

    expect(text.split("\n").slice(1, 7)).toEqual([
      "  before:",
      `    ${make}`,
      "    src/mem.d.ts#Options: type Options = { fenced?: true };",
      "  after:",
      `    ${make}`,
      "    src/mem.d.ts#Options: type Options = { fenced?: boolean };",
    ]);
    expect(text).not.toContain("#Store");
  });

  it("says what a miss found when a changeset lacks the callout", () => {
    const text = renderVerdict(
      judge("stable", "changed", [changeset("minor", PLAIN)]),
      1,
      TEA_BUMP_POLICY.callout,
    );

    expect(text).toContain("found a minor changeset with no callout");
  });

  it("is one line on a pass", () => {
    const text = renderVerdict(
      judge("stable", "changed", [changeset("minor", CALLOUT)]),
      1,
      TEA_BUMP_POLICY.callout,
    );

    expect(text).toBe(
      "api-ratchet: pass — 1 published name changed against 0123456; @demlik/tea changesets since: 1, highest bump minor\n",
    );
  });
});

// The compiler emits the whole package twice, once per side of the diff.
describe.runIf(BASE !== undefined)(
  "published API against TEA_API_BASE",
  { timeout: 300_000 },
  () => {
    it("every changed published name carries the changeset its tier asks for", async () => {
      const run = await runApiRatchet(BASE as string);
      if (!run.passed) expect.fail(`\n${run.text}`);
      console.log(run.text);
    });
  },
);
