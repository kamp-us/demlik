import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type ApiDiffInput,
  type ApiFoundationInput,
  type ApiPoolInput,
  apiFoundationReference,
  apiFoundationSchema,
} from "./api-foundation-reference.mjs";

const binary = process.argv[2];
assert.ok(
  binary,
  "usage: node --import tsx graph-api-foundation.mts <native-driver> [report.json]",
);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.realpathSync(
  fs.mkdtempSync(path.join(tmpdir(), "demlik-api-foundation-")),
);
type Case = {
  id: string;
  operation: "code_graph.api-foundation";
  input: ApiFoundationInput;
};
const cases: Case[] = [];
const add = (id: string, input: unknown) => {
  const item: Case = {
    id,
    operation: "code_graph.api-foundation",
    input: apiFoundationSchema.parse(input),
  };
  cases.push(item);
  return item;
};
const normalize = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));
const own = (rows: [string, unknown][]) => Object.fromEntries(rows);
const bumps = ["none", "patch", "minor", "major"] as const;
const row = (bump = "major", callout = false) => ({
  added: { bump, callout },
  changed: { bump, callout },
  removed: { bump, callout },
});
const policy = (bump = "major", callout = false) => ({
  callout: "BREAKING:",
  tiers: { stable: row(bump, callout) },
});
const pool: ApiPoolInput = {
  references: [
    [],
    [
      ["z#Z", "type Z = string;"],
      ["a#A", "type A = number;"],
    ],
    [
      ["a#A", "type A = number;"],
      ["z#Z", "type Z = string;"],
    ],
    [
      ["a#A", "type A = boolean;"],
      ["z#Z", "type Z = string;"],
    ],
    [
      ["__proto__", "proto own reference"],
      ["constructor", "ctor own reference"],
      ["2", "two"],
      ["10", "ten"],
      ["raw\ud800\nkey", "private\nreference\n"],
    ],
  ],
  entries: [
    { text: "declare function make(): A;", references: 1 },
    { text: "declare function make(): A;", references: 2 },
    { text: "declare function make(): A;", references: 3 },
    { text: "declare const version: 2;", references: 0 },
    { text: "declare function make(): A;\n", references: 1 },
    { text: "\ud800 first\nsecond\r\n", references: 4 },
    { text: "", references: 0 },
    { text: "declare function make(): A;", references: 0 },
    { text: "same references object", references: 1 },
  ],
};
const diff = (
  parts: ApiDiffInput["subpaths"] = [
    {
      subpath: ".",
      tier: "stable",
      added: [],
      changed: [["make", 0, 2]],
      removed: [],
    },
  ],
): ApiDiffInput => ({
  root: "/package",
  base: "0123456789abcdef",
  compiler: "source compiler",
  subpaths: parts,
});
const counted = (bump: string, body = "ordinary") => ({
  package: "pkg",
  changesets: bump === "none" ? [] : [{ file: "change.md", bump, body }],
});
const context = { changes: 1, callout: "BREAKING:" };
const ratchet = (id: string, p: unknown, changesets: unknown, d = diff()) =>
  add(id, { action: "ratchet", pool, diff: d, policy: p, changesets, context });
try {
  const roots: unknown[] = [
    null,
    [],
    true,
    0,
    "x",
    {},
    { ".": null },
    { ".": [] },
    { ".": true },
    { ".": {} },
    { ".": { entry: null, tier: 1, extra: 0 } },
    { ".": { entry: "", tier: "" } },
    { "": { entry: null } },
    { ".": { entry: "a.ts", tier: null } },
    { ".": { entry: "a.ts", extra: 0, another: 1 } },
  ];
  for (const [i, value] of roots.entries())
    add(`map-schema-${i}`, { action: "parse-map", value });
  for (const value of [null, false, 0, "x", [], {}, { entry: "ok.ts" }])
    add(`map-dropped-proto-${JSON.stringify(value)}`, {
      action: "parse-map",
      value: own([["__proto__", value]]),
    });
  for (const value of [
    null,
    0,
    {},
    { entry: "x.ts" },
    { prototype: { isPrototypeOf: false } },
  ])
    add(`map-constructor-${JSON.stringify(value)}`, {
      action: "parse-map",
      value: own([["constructor", value]]),
    });
  add("map-raw-keys-and-entries", {
    action: "parse-map",
    value: own([
      ["raw\ud800", { entry: "\udfff.ts", tier: "raw\ud800" }],
      ["2", { entry: "two.ts" }],
      ["1", { entry: "one.ts", tier: "opaque" }],
      ["01", { entry: "leading.ts" }],
      ["__proto__", null],
    ]),
  });
  add("map-nested-proto-is-strict-unknown", {
    action: "parse-map",
    value: {
      ".": own([
        ["entry", "a.ts"],
        ["__proto__", 1],
        ["constructor", 2],
      ]),
    },
  });
  const policyRoots: unknown[] = [
    null,
    [],
    0,
    false,
    "x",
    {},
    { callout: "!" },
    { tiers: {} },
    { callout: "", tiers: {} },
    { callout: 0, tiers: null },
    { callout: "!", tiers: [] },
    { callout: "!", tiers: 1 },
    { callout: "!", tiers: {} },
    { callout: "!", tiers: {}, default: null },
    { callout: "!", tiers: { s: null } },
    { callout: "!", tiers: { s: {} } },
    { callout: "!", tiers: { "": null } },
    { callout: "!", tiers: {}, extra: 0 },
    { callout: "", tiers: { s: { added: { bump: "huge", x: 1 } } }, extra: 0 },
  ];
  for (const [i, value] of policyRoots.entries()) {
    add(`policy-schema-${i}`, { action: "parse-policy", value });
    add(`policy-refusal-${i}`, { action: "policy", value });
  }
  for (const [i, value] of [
    null,
    0,
    false,
    {},
    { prototype: { isPrototypeOf: true } },
  ].entries()) {
    add(`policy-constructor-${i}`, {
      action: "parse-policy",
      value: { callout: 0, tiers: own([["constructor", value]]) },
    });
  }
  for (const [i, value] of [null, 0, {}, row()].entries())
    add(`policy-proto-dropped-${i}`, {
      action: "parse-policy",
      value: { callout: "!", tiers: own([["__proto__", value]]) },
    });
  for (const [i, value] of [
    undefined,
    null,
    0,
    false,
    [],
    {},
    "NONE",
    "Patch",
    "patch",
  ].entries()) {
    const rule = value === undefined ? {} : { bump: value };
    add(`policy-rule-bump-${i}`, {
      action: "parse-policy",
      value: {
        callout: "!",
        tiers: { s: { added: rule, changed: rule, removed: rule } },
      },
    });
  }
  for (const [i, value] of [null, 0, "false", [], false, true].entries())
    add(`policy-rule-callout-${i}`, {
      action: "parse-policy",
      value: {
        callout: "!",
        tiers: { s: { ...row(), changed: { bump: "minor", callout: value } } },
      },
    });
  add("policy-defaults-each-missing-callout", {
    action: "parse-policy",
    value: {
      callout: "raw\ud800",
      tiers: own([
        [
          "raw\ud800",
          {
            added: { bump: "none" },
            changed: { bump: "minor" },
            removed: { bump: "major" },
          },
        ],
        ["2", row("patch")],
        ["1", row("none")],
      ]),
      default: row("major", true),
    },
  });
  add("policy-strict-order-and-unknown-keys", {
    action: "parse-policy",
    value: {
      callout: "!",
      tiers: {
        s: {
          added: own([
            ["bump", "minor"],
            ["__proto__", 0],
            ["constructor", 0],
          ]),
          changed: [],
          removed: { bump: null, callout: null, extra: 0 },
          extra: 0,
        },
      },
      default: { extra: 0 },
      extra: 0,
    },
  });
  const packageRoot = path.join(directory, "package");
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  const files = [
    "a.ts",
    "b.tsx",
    "c.mts",
    "d.cts",
    "old.d.ts",
    "old.d.mts",
    "old.d.cts",
    "allowed.d.tsx",
    "e.js",
    "CAP.TS",
    "line.ts\n",
    "line.ts\r",
    "line.ts\u2028",
    "line.ts\u2029",
    "..inside.ts",
    "raw�.ts",
    " src.ts",
    ".ts",
  ];
  for (const file of files)
    fs.writeFileSync(
      path.join(packageRoot, "src", file),
      "export const x = 1;\n",
    );
  fs.mkdirSync(path.join(packageRoot, "src", "directory.ts"));
  const outside = path.join(directory, "outside.ts");
  fs.writeFileSync(outside, "export const outside = 1;\n");
  fs.symlinkSync(outside, path.join(packageRoot, "src", "symlink.ts"));
  fs.symlinkSync(
    path.join(directory, "missing.ts"),
    path.join(packageRoot, "src", "dangling.ts"),
  );
  const subpaths = (
    id: string,
    entry: string,
    base: string | null = null,
    root = packageRoot,
  ) =>
    add(id, {
      action: "subpaths",
      root,
      map: { ".": { entry, tier: "stable" } },
      base,
    });
  for (const [i, file] of files.entries())
    subpaths(`source-file-${i}`, `src/${file}`);
  for (const [i, file] of [
    "src/missing.ts",
    "src/directory.ts",
    "src/symlink.ts",
    "src/dangling.ts",
    "src/a.ts/",
    "src/a.ts\0",
    "src/../src/./a.ts",
    "./src/a.ts",
    "src/",
    "..inside.ts",
    "src/../../outside.ts",
    outside,
    path.join(packageRoot, "src/a.ts"),
  ].entries())
    subpaths(`filesystem-${i}`, file);
  fs.writeFileSync(path.join(packageRoot, "..inside.ts"), "export {};");
  subpaths("dotdot-basename-source-refusal", "..inside.ts");
  subpaths("raw-entry-kept-before-native-byte-encoding", "src/raw\ud800.ts");
  subpaths("root-trailing-separators", "src/a.ts", null, `${packageRoot}///`);
  subpaths(
    "relative-root-uses-cwd",
    "src/a.ts",
    null,
    path.relative(process.cwd(), packageRoot),
  );
  subpaths("containment-before-extension-and-existence", "../outside.js");
  subpaths("extension-before-existence", "src/missing.js");
  add("subpath-ordinal-first-refusal", {
    action: "subpaths",
    root: packageRoot,
    map: own([
      ["z", { entry: "src/missing.ts" }],
      ["ä", { entry: "src/missing.cts" }],
      ["a", { entry: "src/missing.js" }],
    ]),
    base: null,
  });
  add("subpath-ordinal-and-opaque-tiers", {
    action: "subpaths",
    root: packageRoot,
    map: own([
      ["2", { entry: "src/a.ts" }],
      ["10", { entry: "src/b.tsx", tier: "x" }],
      ["01", { entry: "src/c.mts" }],
      ["raw\ud800", { entry: "src/d.cts", tier: "\udfff" }],
      ["__proto__", null],
    ]),
    base: null,
  });
  for (const [i, value] of [
    {},
    null,
    { ".": { entry: "" } },
    { ".": { entry: "src/missing.ts" } },
    { ".": { entry: "../outside.ts" } },
    { ".": { entry: "src/a.ts" } },
  ].entries()) {
    add(`base-map-${i}`, {
      action: "subpaths",
      root: packageRoot,
      map: value,
      base: "12345678901😀abcdef",
    });
    add(`working-map-${i}`, {
      action: "subpaths",
      root: packageRoot,
      map: value,
      base: null,
    });
  }
  for (const [i, names] of [
    { before: [["make", 0]], after: [["make", 1]] },
    { before: [["make", 0]], after: [["make", 2]] },
    { before: [["make", 0]], after: [["make", 7]] },
    { before: [["make", 0]], after: [["make", 4]] },
    {
      before: [],
      after: [
        ["added", 3],
        ["constructor", 0],
        ["__proto__", 5],
        ["2", 3],
        ["1", 0],
      ],
    },
    {
      before: [
        ["removed", 3],
        ["constructor", 0],
        ["__proto__", 5],
        ["2", 3],
        ["1", 0],
      ],
      after: [],
    },
    {
      before: [
        ["__proto__", 0],
        ["constructor", 0],
        ["make", 0],
      ],
      after: [
        ["__proto__", 2],
        ["constructor", 2],
        ["make", 2],
      ],
    },
    { before: [["raw\ud800", 5]], after: [["raw\ud800", 6]] },
    {
      before: [
        ["added", 0],
        ["added", 2],
      ],
      after: [["added", 2]],
    },
    { before: [], after: [] },
  ].entries())
    add(`pure-diff-${i}`, {
      action: "diff",
      pool,
      tier: i % 2 ? null : "stable",
      ...names,
    });
  const collisions = diff([
    {
      subpath: "2",
      tier: null,
      added: [
        ["same", 5],
        ["__proto__", 5],
      ],
      changed: [
        ["same", 0, 2],
        ["constructor", 0, 2],
      ],
      removed: [["same", 0]],
    },
    {
      subpath: "10",
      tier: "raw\ud800",
      added: [["a", 6]],
      changed: [],
      removed: [],
    },
    {
      subpath: "raw\ud800",
      tier: "",
      added: [
        ["\ue000", 3],
        ["😀", 3],
        ["a", 3],
        ["A", 3],
      ],
      changed: [],
      removed: [],
    },
  ]);
  add("changes-own-records-collisions-order-and-identity", {
    action: "changes",
    pool,
    diff: collisions,
  });
  add("changes-empty-does-not-invent-names", {
    action: "changes",
    pool,
    diff: diff([]),
  });
  for (const needed of bumps)
    for (const found of bumps)
      for (const callout of [false, true])
        for (const present of [false, true])
          ratchet(
            `ratchet-${needed}-${found}-${callout}-${present}`,
            policy(needed, callout),
            counted(
              found,
              present ? "before BREAKING: after" : "breaking: lower case",
            ),
          );
  ratchet("callout-from-another-counted-changeset", policy("major", true), {
    package: "pkg",
    changesets: [
      { file: "z.md", bump: "major", body: "ordinary" },
      { file: "a.md", bump: "patch", body: "BREAKING: yes" },
      { file: "a.md", bump: "minor", body: "" },
    ],
  });
  ratchet(
    "no-row-no-default-is-refused",
    { callout: "!", tiers: {} },
    counted("major"),
  );
  ratchet(
    "null-tier-no-default-is-refused",
    { callout: "!", tiers: {} },
    counted("major"),
    diff([
      {
        subpath: "./untyped",
        tier: null,
        added: [["n", 3]],
        changed: [],
        removed: [],
      },
    ]),
  );
  ratchet(
    "unknown-tier-uses-explicit-default",
    { callout: "!", tiers: {}, default: row("minor") },
    counted("minor"),
    collisions,
  );
  ratchet(
    "specific-tier-precedes-default",
    { ...policy("major"), default: row("none") },
    counted("minor"),
  );
  ratchet(
    "unchanged-subpath-needs-no-policy-row",
    { callout: "!", tiers: {} },
    counted("none"),
    diff([
      { subpath: ".", tier: "missing", added: [], changed: [], removed: [] },
    ]),
  );
  ratchet(
    "empty-diff-still-validates-policy",
    { callout: "", tiers: {} },
    counted("none"),
    diff([]),
  );
  ratchet(
    "rules-shared-per-kind-not-per-equal-shape",
    policy("major", true),
    counted("none"),
    diff([
      {
        subpath: ".",
        tier: "stable",
        added: [
          ["a", 3],
          ["b", 3],
        ],
        changed: [
          ["c", 0, 2],
          ["d", 0, 2],
        ],
        removed: [
          ["e", 0],
          ["f", 0],
        ],
      },
    ]),
  );
  for (const [i, marker] of [
    "\ud800",
    "\ud83d",
    "😀",
    "line\nmarker",
    "\udfff",
  ].entries())
    ratchet(
      `callout-exact-utf16-${i}`,
      { callout: marker, tiers: { stable: row("patch", true) } },
      counted("patch", `start ${i === 1 ? "😀" : marker} end`),
    );
  ratchet(
    "prototype-tier-is-own-only",
    {
      callout: "!",
      tiers: own([
        ["__proto__", row("none")],
        ["constructor", row("none")],
      ]),
    },
    counted("major"),
    diff([
      {
        subpath: ".",
        tier: "__proto__",
        added: [["n", 3]],
        changed: [],
        removed: [],
      },
    ]),
  );
  const emptyVerdict = {
    passed: true,
    base: "123456😀abcdef",
    package: "pkg",
    changesets: [],
    highestBump: "none",
    calloutFound: false,
    misses: [],
  };
  const numbers = [
    0,
    "-0",
    1,
    2,
    -1,
    0.5,
    -0.5,
    1e21,
    1e-7,
    9007199254740992,
    "NaN",
    "Infinity",
    "-Infinity",
  ];
  for (const [i, changes] of numbers.entries())
    for (const passed of [false, true])
      add(`render-count-${i}-${passed}`, {
        action: "render",
        pool,
        verdict: { ...emptyVerdict, passed },
        context: { changes, callout: "!" },
      });
  for (const [i, highestBump] of bumps.entries())
    for (const calloutFound of [false, true])
      for (const callout of [false, true])
        add(`render-miss-${i}-${calloutFound}-${callout}`, {
          action: "render",
          pool,
          verdict: {
            ...emptyVerdict,
            passed: false,
            highestBump,
            calloutFound,
            misses: [
              {
                subpath: "raw\ud800\nsubpath",
                tier: null,
                name: "new\udfff",
                kind: "added",
                before: null,
                after: 5,
                needs: { bump: highestBump, callout },
              },
              {
                subpath: ".",
                tier: "",
                name: "old",
                kind: "removed",
                before: 6,
                after: null,
                needs: { bump: "major", callout },
              },
            ],
          },
          context: { changes: 2, callout: 'raw\udfff\n"marker"' },
        });
  add("render-one-miss-singular-summary", {
    action: "render",
    pool,
    verdict: {
      ...emptyVerdict,
      passed: false,
      highestBump: "minor",
      misses: [
        {
          subpath: ".",
          tier: "stable",
          name: "make",
          kind: "changed",
          before: 0,
          after: 2,
          needs: { bump: "major", callout: false },
        },
      ],
    },
    context,
  });
  add("render-pass-ignores-opaque-misses", {
    action: "render",
    pool,
    verdict: {
      ...emptyVerdict,
      misses: [
        {
          subpath: ".",
          tier: null,
          name: "opaque",
          kind: "added",
          before: null,
          after: 5,
          needs: { bump: "major", callout: true },
        },
      ],
    },
    context,
  });

  const rawRoot = `${directory}/raw\ud800`;
  fs.mkdirSync(`${directory}/raw�`);
  fs.writeFileSync(`${directory}/raw�/index.ts`, "export const raw = true;");
  subpaths("raw-root-kept-until-native-filesystem", "index.ts", null, rawRoot);
  add("raw-schema-first-location-and-refusal", {
    action: "subpaths",
    root: packageRoot,
    map: own([["raw\ud800", { entry: null }]]),
    base: null,
  });
  add("policy-empty-key-skips-value-constructor", {
    action: "parse-policy",
    value: { callout: "!", tiers: { "": { constructor: null } } },
  });
  ratchet(
    "policy-error-precedes-uncovered-change",
    { callout: "", tiers: {} },
    counted("none"),
  );
  add("pure-diff-shared-reference-aliases", {
    action: "diff",
    pool,
    tier: "stable",
    before: [["make", 0]],
    after: [
      ["make", 2],
      ["alias", 8],
    ],
  });
  add("pure-diff-large-shared-facts", {
    action: "diff",
    pool,
    tier: "stable",
    before: Array.from({ length: 240 }, (_, i) => [
      `name${String(i).padStart(3, "0")}`,
      0,
    ]),
    after: [
      ...Array.from({ length: 240 }, (_, i) => i)
        .filter((i) => i % 4 !== 0)
        .map((i) => [
          `name${String(i).padStart(3, "0")}`,
          i % 4 === 1 ? 1 : i % 4 === 2 ? 2 : 3,
        ]),
      ...Array.from({ length: 60 }, (_, i) => [`name${i + 240}`, 3]),
    ],
  });
  const expected = cases.map((item) =>
    normalize(apiFoundationReference(item.input)),
  );
  const at = (id: string) =>
    expected[cases.findIndex((item) => item.id === id)];
  assert.deepEqual(at("pure-diff-0"), {
    diff: { tier: "stable", added: {}, removed: {}, changed: {} },
    keys: [[], [], []],
    prototypes: { added: null, changed: null, removed: null },
    changes: [],
    identities: [],
  });
  assert.deepEqual(at("map-schema-5"), {
    success: false,
    issues: [
      { code: "custom", path: [], message: "the API map names no subpath" },
    ],
  });
  const failed = z
    .object({
      verdict: z.object({
        passed: z.literal(false),
        highestBump: z.literal("patch"),
        misses: z.array(z.unknown()).length(1),
      }),
    })
    .parse(at("ratchet-major-patch-false-false"));
  assert.equal(failed.verdict.misses.length, 1);
  assert.deepEqual(at("base-map-0"), []);
  assert.match(
    z
      .array(z.object({ entryAbsolute: z.string() }))
      .parse(at("filesystem-2"))[0].entryAbsolute,
    /src\/symlink\.ts$/,
  );
  assert.deepEqual(
    z
      .object({
        verdict: z.object({
          changesets: z.array(z.string()),
          passed: z.boolean(),
        }),
      })
      .parse(at("callout-from-another-counted-changeset")).verdict,
    { changesets: ["a.md", "a.md", "z.md"], passed: true },
  );
  assert.equal(
    z.object({ text: z.string() }).parse(at("render-count-2-true")).text,
    "API RATCHET: pass — 1 change against 123456\ud83d, highest changeset bump none, no callout\n",
  );
  const large = z
    .object({
      diff: z.object({
        added: z.record(z.string(), z.unknown()),
        removed: z.record(z.string(), z.unknown()),
        changed: z.record(z.string(), z.unknown()),
      }),
      changes: z.array(z.unknown()),
    })
    .parse(at("pure-diff-large-shared-facts"));
  assert.equal(Object.keys(large.diff.added).length, 60);
  assert.equal(Object.keys(large.diff.removed).length, 60);
  assert.equal(Object.keys(large.diff.changed).length, 120);
  assert.equal(large.changes.length, 240);
  const invalid: unknown[] = [
    {
      id: "invalid-operation",
      operation: "other",
      input: { action: "parse-map", value: {} },
    },
    {
      id: "invalid-wrapper-extra",
      operation: "code_graph.api-foundation",
      input: { action: "parse-map", value: {} },
      extra: true,
    },
    {
      id: "invalid-input-extra",
      operation: "code_graph.api-foundation",
      input: { action: "parse-map", value: {}, extra: 0 },
    },
    {
      id: "invalid-action",
      operation: "code_graph.api-foundation",
      input: { action: "unknown" },
    },
    {
      id: "missing-value",
      operation: "code_graph.api-foundation",
      input: { action: "parse-map" },
    },
    {
      id: "invalid-root-type",
      operation: "code_graph.api-foundation",
      input: { action: "subpaths", root: 0, map: {}, base: null },
    },
    {
      id: "invalid-pool-reference",
      operation: "code_graph.api-foundation",
      input: {
        action: "diff",
        pool: { references: [], entries: [{ text: "x", references: 0 }] },
        tier: null,
        before: [],
        after: [],
      },
    },
    {
      id: "invalid-pool-entry",
      operation: "code_graph.api-foundation",
      input: {
        action: "diff",
        pool,
        tier: null,
        before: [["n", 999]],
        after: [],
      },
    },
    {
      id: "invalid-counted-bump",
      operation: "code_graph.api-foundation",
      input: {
        action: "ratchet",
        pool,
        diff: diff(),
        policy: policy(),
        changesets: {
          package: "pkg",
          changesets: [{ file: "a", bump: "none", body: "" }],
        },
        context,
      },
    },
    {
      id: "invalid-context-number",
      operation: "code_graph.api-foundation",
      input: {
        action: "render",
        pool,
        verdict: emptyVerdict,
        context: { changes: "huge", callout: "!" },
      },
    },
  ];
  invalid.push({
    id: "missing-opaque-tier",
    operation: "code_graph.api-foundation",
    input: {
      action: "changes",
      pool,
      diff: {
        ...diff(),
        subpaths: [{ subpath: ".", added: [], changed: [], removed: [] }],
      },
    },
  });
  const requests = [...cases, ...invalid];
  const run = spawnSync(binary, [], {
    input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const reply = z.strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.strictObject({ tag: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  });
  const answers = run.stdout
    .trimEnd()
    .split("\n")
    .map((line) => reply.parse(JSON.parse(line)));
  assert.equal(answers.length, requests.length);
  const failures = [];
  for (const [i, item] of cases.entries()) {
    const answer = answers[i];
    try {
      assert.equal(answer.id, item.id);
      assert.equal(answer.ok, true, JSON.stringify(answer.error));
      assert.deepEqual(answer.output, expected[i]);
      assert.ok(answer.observedCalls.length > 0);
    } catch (error) {
      failures.push({
        id: item.id,
        message: String(error),
        expected: expected[i],
        actual: answer,
      });
    }
  }
  for (const [i] of invalid.entries()) {
    const answer = answers[cases.length + i];
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.tag, "driver-error");
    assert.deepEqual(answer.observedCalls, []);
  }
  const sources = [
    "api/map.ts",
    "api/diff.ts",
    "api/read.ts",
    "api/ratchet/policy.ts",
    "api/ratchet/verdict.ts",
    "api/ratchet/text.ts",
    "api/ratchet/changesets.ts",
  ];
  const report = {
    passed: cases.length - failures.length,
    attempted: cases.length,
    rejectedInvalidInputs: invalid.length,
    reference: {
      node: process.version,
      v8: process.versions.v8,
      source: sources,
      sourceHashes: Object.fromEntries(
        sources.map((file) => [
          file,
          createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(repository, "packages/code-graph/src", file),
              ),
            )
            .digest("hex"),
        ]),
      ),
      native:
        "actual native API map/schema/files, pure diff/changes, bump policy, verdict and text functions; shared Arc identity observed",
    },
    caseCounts: Object.fromEntries(
      [...new Set(cases.map((item) => item.input.action))].map((action) => [
        action,
        cases.filter((item) => item.input.action === action).length,
      ]),
    ),
    failures,
    cases: requests.map((item, i) => ({
      ...Object(item),
      expected: i < cases.length ? expected[i] : { rejected: true },
      ...answers[i],
    })),
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: invalid.length, failures: failures.map((row) => row.id), caseCounts: report.caseCounts })}\n`,
  );
  assert.deepEqual(
    failures.map((row) => row.id),
    [],
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
