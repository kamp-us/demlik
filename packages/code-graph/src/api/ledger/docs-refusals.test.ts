import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCS_MAP,
  DOCS_SHAPE,
  docsPackage,
  removePackage,
  runDocsCli,
  snapshot,
} from "../docs/docs-package.fixture.js";
import { API_DOCS_LEDGER_FILENAME } from "./docs.js";
import { accept, check, gateArgs, ledgerFile } from "./docs-ledger.fixture.js";

// What the doc gate refuses (SPEC §13.11): exit 2, one stderr line, nothing on stdout and no file
// written or changed.
let root: string;
beforeEach(() => {
  root = docsPackage();
});
afterEach(() => removePackage(root));

describe(
  "the doc gate — refusals exit 2, print one line and write nothing",
  { timeout: 240_000 },
  () => {
    it.each([
      ["--accept-api-docs without --reason", ["--accept-api-docs"]],
      ["--accept-api-docs with a blank --reason", ["--accept-api-docs", "--reason", "  "]],
      ["--accept-api-docs with --ci", ["--accept-api-docs", "--ci", "--reason", "baseline"]],
      ["--ci with --reason", ["--ci", "--reason", "baseline"]],
      ["--ci with a gate flag", ["--ci", "--unreachable"]],
      ["--ci with --api-base", ["--ci", "--api-base", "HEAD"]],
      ["--ci with --accept-api", ["--ci", "--accept-api"]],
      [
        "--accept-api-docs with --api-policy",
        ["--accept-api-docs", "--reason", "why", "--api-policy", "p.json"],
      ],
      [
        "--accept-api-docs with --accept-api",
        ["--accept-api-docs", "--accept-api", "--reason", "why"],
      ],
      ["--reason alone", ["--reason", "baseline"]],
    ])("%s", (_, flags) => {
      const before = snapshot(root);
      const run = runDocsCli([...gateArgs(root), ...flags]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(snapshot(root)).toEqual(before);
    });

    it.each([
      ["--api-docs", ["--api", DOCS_MAP]],
      ["--api", ["--api-docs", DOCS_SHAPE]],
      ["both", []],
    ])("--accept-api-docs without %s", (_, args) => {
      const run = runDocsCli([root, ...args, "--accept-api-docs", "--reason", "baseline"]);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(
        "code-graph: --accept-api-docs needs --api <map> --api-docs <shape>; nothing was written.\n",
      );
      expect(fs.existsSync(ledgerFile(root))).toBe(false);
    });

    it.each([
      ["unreadable JSON", "{ not json"],
      ["a schema-invalid entry", '{ "entries": [{ "scope": ".", "file": "src/core.ts" }] }\n'],
      [
        "an unknown key",
        '{ "entries": [{ "scope": ".", "block": "export", "file": "src/core.ts", "name": "parse", "line": 48, "reason": "kept" }] }\n',
      ],
      [
        "a blank reason",
        '{ "entries": [{ "scope": ".", "block": "export", "file": "src/core.ts", "name": "parse", "reason": " " }] }\n',
      ],
      [
        "a duplicate",
        `{ "entries": [${Array(2)
          .fill(
            '{ "scope": "elsewhere", "block": "export", "file": "src/core.ts", "name": "parse", "reason": "kept" }',
          )
          .join(", ")}] }\n`,
      ],
    ])("exits 2 before any program opens on %s", (_, text) => {
      // With no tsconfig the program could not open, so a refusal naming the ledger came before it.
      fs.rmSync(path.join(root, "tsconfig.json"));
      fs.writeFileSync(ledgerFile(root), text);
      for (const run of [check(root), accept(root, "baseline")]) {
        expect(run.code).toBe(2);
        expect(run.stdout).toBe("");
        expect(run.stderr.trim().split("\n")).toHaveLength(1);
        expect(run.stderr).toContain(`invalid API docs ledger "${ledgerFile(root)}"`);
        expect(run.stderr).toContain("nothing was written");
        expect(fs.readFileSync(ledgerFile(root), "utf8")).toBe(text);
      }
    });

    it("refuses a bad shape before it reads the ledger", () => {
      fs.writeFileSync(ledgerFile(root), "{ not json");
      const shape = path.join(root, "bad-shape.json");
      fs.writeFileSync(shape, '{ "sections": [] }');
      const run = check(root, [], { shape });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("API docs shape");
      expect(run.stderr).not.toContain(API_DOCS_LEDGER_FILENAME);
    });

    it("writes nothing when the map is bad, whatever the ledger holds", () => {
      const map = path.join(root, "bad-map.json");
      fs.writeFileSync(map, "{}");
      const args = [root, "--api", map, "--api-docs", DOCS_SHAPE];
      expect(runDocsCli([...args, "--accept-api-docs", "--reason", "baseline"]).code).toBe(2);
      expect(fs.existsSync(ledgerFile(root))).toBe(false);
      expect(runDocsCli([...args, "--ci"]).code).toBe(2);
    });

    it("leaves a plain --ci to the smell gate and --api --ci to the API ledger", () => {
      fs.writeFileSync(ledgerFile(root), "{ not json");
      const smells = runDocsCli([root, "--ci"]);
      expect(smells.stdout).toContain("code-graph CI:");
      const names = runDocsCli([root, "--api", DOCS_MAP, "--ci"]);
      expect(names.stderr).not.toContain(API_DOCS_LEDGER_FILENAME);
      expect(names.stdout).toContain("API LEDGER FAILED");
    });
  },
);
