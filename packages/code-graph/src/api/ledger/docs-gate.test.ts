import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCS_REPORT,
  DOCS_SHAPE,
  docsPackage,
  removePackage,
  runDocsCli,
  writeDocsPackage,
} from "../docs/docs-package.fixture.js";
import { API_DOCS_LEDGER_FILENAME } from "./docs.js";
import {
  accept,
  append,
  check,
  entries,
  FAILED_TAIL,
  FINDING_LINES,
  gateArgs,
  IN_SHAPE,
  keysOf,
  ledgerFile,
  ledgerText,
  lineOf,
  replaceIn,
  WITH_A_FINDING,
} from "./docs-ledger.fixture.js";

// The doc gate end to end (SPEC §13.11), through the CLI entry, over the doc report's fixture
// package in a folder that is no git repository.
let root: string;
beforeEach(() => {
  root = docsPackage();
});
afterEach(() => removePackage(root));

// The entry line of each declaration with a finding, in the report's order.
const BASELINE_KEYS: readonly string[] = [
  ...new Set(
    FINDING_LINES.map((line) => {
      const [at = "", name = ""] = line.split("  ");
      return `${at.slice(0, at.lastIndexOf(":"))}  ${name}`;
    }),
  ),
];

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe("code-graph --api <map> --api-docs <shape> --ci", { timeout: 240_000 }, () => {
  it("fails on every declaration out of shape, accepts them, then fails only on a new one, prunes a fixed one and settles", () => {
    const first = check(root);
    expect(first.code).toBe(1);
    expect(first.stdout).toBe(
      [
        `API DOCS LEDGER FAILED — ${WITH_A_FINDING} declaration(s) in scope . not in ${API_DOCS_LEDGER_FILENAME}:`,
        ...FINDING_LINES.map((line) => `  ${line}`),
        FAILED_TAIL,
        "",
      ].join("\n"),
    );
    expect(first.stderr).toBe("");
    expect(fs.existsSync(ledgerFile(root))).toBe(false);

    const baseline = accept(root, "  baseline ");
    expect(baseline.code).toBe(0);
    expect(baseline.stdout).toBe(
      [
        `accepted ${WITH_A_FINDING} declaration(s) of scope . into ${API_DOCS_LEDGER_FILENAME}, reason "baseline":`,
        ...BASELINE_KEYS.map((key) => `  ${key}`),
        "",
      ].join("\n"),
    );
    expect(entries(root)).toHaveLength(WITH_A_FINDING);
    expect(entries(root)).toContainEqual({
      scope: ".",
      block: "export",
      file: "src/units.ts",
      name: "Labels.long",
      reason: "baseline",
    });
    // The file is sorted by scope, block, file, then name, each by code unit.
    expect(keysOf(entries(root))).toEqual([...BASELINE_KEYS].sort(byCodeUnit));
    expect(BASELINE_KEYS).not.toEqual([...BASELINE_KEYS].sort(byCodeUnit));

    const passed = check(root);
    expect(passed.code).toBe(0);
    expect(passed.stdout).toBe(
      `api docs ledger: PASS — scope ., ${WITH_A_FINDING} recorded declaration(s), none new.\n`,
    );

    // One new export with no block, and one documented export that loses a required tag.
    append(root, "src/labs/index.ts", "\nexport function added(): number {\n  return 1;\n}\n");
    replaceIn(
      root,
      "src/labs/index.ts",
      " * Starts a trial.\n *\n * @stability experimental\n * @category constructors\n",
      " * Starts a trial.\n *\n * @stability experimental\n",
    );
    const failed = check(root);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe(
      [
        `API DOCS LEDGER FAILED — 2 declaration(s) in scope . not in ${API_DOCS_LEDGER_FILENAME}:`,
        `  src/labs/index.ts:${lineOf(root, "src/labs/index.ts", "export function trial")}  trial  missing @category`,
        `  src/labs/index.ts:${lineOf(root, "src/labs/index.ts", "export function added")}  added  no doc block`,
        FAILED_TAIL,
        "",
      ].join("\n"),
    );
    expect(entries(root)).toHaveLength(WITH_A_FINDING);

    expect(accept(root, "two more").code).toBe(0);
    expect(entries(root)).toHaveLength(WITH_A_FINDING + 2);
    expect(check(root).code).toBe(0);

    replaceIn(
      root,
      "src/core.ts",
      "export function parse(input: string): number;",
      `${IN_SHAPE("Parses either way.")}export function parse(input: string): number;`,
    );
    const pruned = check(root);
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toBe(
      [
        `api docs ledger: PASS — scope ., ${WITH_A_FINDING + 1} recorded declaration(s), none new.`,
        `pruned 1 entry from ${API_DOCS_LEDGER_FILENAME} — the declaration has no finding any more:`,
        "  src/core.ts  parse",
        "",
      ].join("\n"),
    );
    expect(keysOf(entries(root))).not.toContain("src/core.ts  parse");

    const settled = ledgerText(root);
    const again = check(root);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(
      `api docs ledger: PASS — scope ., ${WITH_A_FINDING + 1} recorded declaration(s), none new.\n`,
    );
    expect(check(root)).toEqual(again);
    expect(ledgerText(root)).toBe(settled);
  });

  it("keeps a declaration a re-accept already holds with the reason it was first given", () => {
    accept(root, "baseline");
    append(root, "src/labs/index.ts", "\nexport const LATE = 1;\n");
    const later = accept(root, "later");
    expect(later.stdout).toBe(
      [
        `accepted 1 declaration(s) of scope . into ${API_DOCS_LEDGER_FILENAME}, reason "later":`,
        "  src/labs/index.ts  LATE",
        "",
      ].join("\n"),
    );
    const reasons = new Map(entries(root).map(({ name, reason }) => [name, reason]));
    expect(reasons.get("parse")).toBe("baseline");
    expect(reasons.get("LATE")).toBe("later");

    const before = ledgerText(root);
    const nothing = accept(root, "again");
    expect(nothing.code).toBe(0);
    expect(nothing.stdout).toBe("accept-api-docs: no unrecorded declaration — nothing to add.\n");
    expect(ledgerText(root)).toBe(before);
  });

  it("does not fail when an excused declaration's findings change, nor touch the ledger", () => {
    accept(root, "baseline");
    const before = ledgerText(root);
    // `format` had an empty description; now it also lacks a required tag.
    replaceIn(root, "src/core.ts", " * @stability stable\n * @category formatting\n", "");
    const run = runDocsCli(gateArgs(root));
    expect(run.stdout).toContain("  format  missing @category\n");
    expect(check(root).code).toBe(0);
    expect(ledgerText(root)).toBe(before);
  });

  it("holds two namespaces' members of one name apart", () => {
    accept(root, "baseline");
    append(
      root,
      "src/units.ts",
      '\nexport namespace Other {\n  export function long(): string {\n    return "";\n  }\n}\n',
    );
    const run = check(root, ["--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).unrecorded).toEqual([
      { scope: ".", block: "export", file: "src/units.ts", name: "Other" },
      { scope: ".", block: "export", file: "src/units.ts", name: "Other.long" },
    ]);
  });

  it("fails on a renamed declaration and prunes the name it had, in one run", () => {
    accept(root, "baseline");
    replaceIn(root, "src/labs/index.ts", "export function probe()", "export function probed()");
    const run = check(root, ["--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      passed: false,
      scope: ".",
      unrecorded: [{ scope: ".", block: "export", file: "src/labs/index.ts", name: "probed" }],
      pruned: [
        {
          scope: ".",
          block: "export",
          file: "src/labs/index.ts",
          name: "probe",
          reason: "baseline",
        },
      ],
    });
    expect(keysOf(entries(root))).not.toContain("src/labs/index.ts  probe");
  });

  it("prunes the entries of a file the shape now skips", () => {
    accept(root, "baseline");
    const shape = JSON.parse(fs.readFileSync(DOCS_SHAPE, "utf8"));
    const skipping = path.join(root, "skipping-shape.json");
    fs.writeFileSync(
      skipping,
      JSON.stringify({ ...shape, skip: [...shape.skip, "src/shared.ts"] }),
    );
    const run = check(root, [], { shape: skipping });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(
      [
        `api docs ledger: PASS — scope ., ${WITH_A_FINDING - 2} recorded declaration(s), none new.`,
        `pruned 2 entries from ${API_DOCS_LEDGER_FILENAME} — the declaration has no finding any more:`,
        "  src/shared.ts  both",
        "  src/shared.ts  sharedDefault",
        "",
      ].join("\n"),
    );
  });

  it("prints the accept's result as one object with --json, and the verdict to --out", () => {
    const run = accept(root, "baseline", ["--json"]);
    expect(run.code).toBe(0);
    const printed = JSON.parse(run.stdout);
    expect(printed).toMatchObject({ scope: ".", pruned: [], reason: "baseline" });
    expect(printed.accepted).toHaveLength(WITH_A_FINDING);
    expect(printed.accepted[0]).toEqual({
      scope: ".",
      block: "export",
      file: "src/core.ts",
      name: "parse",
    });
    expect(printed).not.toHaveProperty("unmeasured");

    append(root, "src/labs/index.ts", "\nexport const LATE = 1;\n");
    const out = path.join(root, "verdict.txt");
    const written = check(root, ["--out", out]);
    expect(written.code).toBe(1);
    expect(fs.readFileSync(out, "utf8")).toContain("  LATE  no doc block\n");
  });

  it("runs no git command, in a folder that is not a git repo", () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-docs-bin-")));
    const called = path.join(scratch, "git-was-called");
    fs.writeFileSync(path.join(scratch, "git"), `#!/bin/sh\ntouch "${called}"\nexit 127\n`, {
      mode: 0o755,
    });
    const env = { PATH: `${scratch}${path.delimiter}${process.env.PATH}` };
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(accept(root, "baseline", [], { env }).code).toBe(0);
    expect(check(root, [], { env }).code).toBe(0);
    expect(fs.existsSync(called)).toBe(false);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("touches only its own package's entries in a workspace", () => {
    const workspace = path.join(root, "repo");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const one = path.join(workspace, "packages", "one");
    const two = path.join(workspace, "packages", "two");
    writeDocsPackage(one);
    writeDocsPackage(two);

    accept(one, "first");
    accept(two, "second");
    expect(fs.existsSync(ledgerFile(one))).toBe(false);
    expect(entries(workspace)).toHaveLength(WITH_A_FINDING * 2);

    replaceIn(
      two,
      "src/make.ts",
      "export function make",
      `${IN_SHAPE("Makes a maker.")}export function make`,
    );
    append(two, "src/labs/index.ts", "\nexport const LATE = 1;\n");
    const run = check(two);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("in scope packages/two not in");
    const makes = entries(workspace).filter(({ name }) => name === "make");
    expect(makes.map(({ scope }) => scope)).toEqual(["packages/one"]);
    expect(check(one).stdout).toBe(
      `api docs ledger: PASS — scope packages/one, ${WITH_A_FINDING} recorded declaration(s), none new.\n`,
    );
  });

  it("leaves the report as it was: no ledger is read, and it exits 0", () => {
    fs.writeFileSync(ledgerFile(root), "{ not json");
    const run = runDocsCli(gateArgs(root));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(DOCS_REPORT);
  });
});
