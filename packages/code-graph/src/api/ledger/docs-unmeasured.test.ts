import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docsPackage, removePackage } from "../docs/docs-package.fixture.js";
import { API_DOCS_LEDGER_FILENAME } from "./docs.js";
import {
  accept,
  append,
  check,
  entries,
  IN_SHAPE,
  keysOf,
  ledgerText,
  replaceIn,
  WITH_A_FINDING,
} from "./docs-ledger.fixture.js";

// The doc gate on a read that could not see everything (SPEC §13.11): nothing is pruned, the gate
// still gates, and the first run with no gap decides.
let root: string;
beforeEach(() => {
  root = docsPackage();
  expect(accept(root, "baseline").code).toBe(0);
  // `parse` is fixed, so a run that saw everything would prune its entry.
  replaceIn(
    root,
    "src/core.ts",
    "export function parse(input: string): number;",
    `${IN_SHAPE("Parses either way.")}export function parse(input: string): number;`,
  );
});
afterEach(() => removePackage(root));

const KEPT_HEAD = `kept 1 entry in ${API_DOCS_LEDGER_FILENAME} — the read could not see everything, so this run cannot say these declarations are fixed or gone; the first run with no gap decides:`;
const PARSE_ENTRY = {
  scope: ".",
  block: "export",
  file: "src/core.ts",
  name: "parse",
  reason: "baseline",
};

const GAPS: readonly (readonly [string, (root: string) => () => void, string])[] = [
  [
    "a re-export that does not resolve",
    (at) => {
      const file = path.join(at, "src/index.ts");
      const before = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, `${before}export * from "./missing";\n`);
      return () => fs.writeFileSync(file, before);
    },
    'src/index.ts names "./missing", which the read could not resolve',
  ],
  [
    "a syntax error in a file that publishes nothing",
    (at) => {
      const file = path.join(at, "src/broken.ts");
      fs.writeFileSync(file, "export function (\n");
      return () => fs.rmSync(file);
    },
    "src/broken.ts has ",
  ],
];

describe("the doc gate on a read with a gap", { timeout: 240_000 }, () => {
  it.each(
    GAPS,
  )("keeps a fixed declaration's entry behind %s, and prunes it on the next run with no gap", (_, open, warning) => {
    const close = open(root);
    const before = ledgerText(root);

    const kept = check(root);
    expect(kept.code).toBe(0);
    expect(kept.stdout).toBe(
      [
        `api docs ledger: PASS — scope ., ${WITH_A_FINDING} recorded declaration(s), none new.`,
        KEPT_HEAD,
        "  src/core.ts  parse",
        "",
      ].join("\n"),
    );
    expect(kept.stderr).toContain(`code-graph: warning: ${warning}`);
    expect(ledgerText(root)).toBe(before);

    const json = check(root, ["--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      passed: true,
      scope: ".",
      unrecorded: [],
      pruned: [],
      unmeasured: [PARSE_ENTRY],
    });
    expect(ledgerText(root)).toBe(before);

    close();
    const pruned = check(root, ["--json"]);
    expect(pruned.code).toBe(0);
    expect(JSON.parse(pruned.stdout)).toEqual({
      passed: true,
      scope: ".",
      unrecorded: [],
      pruned: [PARSE_ENTRY],
    });
    expect(keysOf(entries(root))).not.toContain("src/core.ts  parse");
  });

  it("still fails on a new declaration, and accepts it without dropping what it kept", () => {
    append(root, "src/index.ts", 'export * from "./missing";\n');
    append(root, "src/labs/index.ts", "\nexport const LATE = 1;\n");

    const failed = check(root);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("  LATE  no doc block\n");
    expect(failed.stdout).toContain(`${KEPT_HEAD}\n  src/core.ts  parse\n`);
    expect(entries(root)).toHaveLength(WITH_A_FINDING);

    const accepted = accept(root, "later", ["--json"]);
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({
      scope: ".",
      accepted: [{ scope: ".", block: "export", file: "src/labs/index.ts", name: "LATE" }],
      pruned: [],
      unmeasured: [PARSE_ENTRY],
      reason: "later",
    });
    expect(entries(root)).toHaveLength(WITH_A_FINDING + 1);
    expect(keysOf(entries(root))).toContain("src/core.ts  parse");
    expect(check(root).code).toBe(0);
  });
});
