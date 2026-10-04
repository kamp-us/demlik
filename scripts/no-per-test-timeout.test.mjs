// Fails when a test in any test file under packages/ or scripts/ carries a timeout of its own
// (#575). A suite that needs a long timeout declares it once, on its `describe`, so a test added
// beside its siblings inherits it; a per-test number is the slip that times a new test out on the
// 5s default under load. Hooks, `describe` options and `expect.poll` windows are not tests.

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// The parity fixture's `.test.ts` files are source the CLI reads, not tests vitest runs.
const TEST_FILES = [
  ":(glob)packages/**/*.test.*",
  ":(glob)scripts/**/*.test.*",
  ":(exclude)packages/code-graph/test/parity/fixture",
];

const TEST_ROOTS = new Set(["it", "test"]);

/** The identifier a call chain starts from: `it` for the callee of `it.each(rows)(name, fn)`. */
function rootName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
    return rootName(node.expression);
  }
  if (ts.isTaggedTemplateExpression(node)) return rootName(node.tag);
  return undefined;
}

/** A call that declares a test: its chain starts at `it` or `test`, and it is the chain's last call. */
function declaresTest(call) {
  const isCallee =
    ts.isCallExpression(call.parent) && call.parent.expression === call;
  return TEST_ROOTS.has(rootName(call.expression)) && !isCallee;
}

const isFunction = (node) =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node);

function isTimeoutOption(property) {
  const named =
    ts.isPropertyAssignment(property) ||
    ts.isShorthandPropertyAssignment(property);
  return (
    named &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
    property.name.text === "timeout"
  );
}

/**
 * The nodes of a test declaration that spell its timeout. A test is `(name, options, body)` or
 * `(name, body, timeout)`, and the second argument tells the forms apart:
 * - an options object is read for a `timeout` property, wherever it sits;
 * - any other second argument is the body, however it is spelled (inline, a named function, a
 *   member access), and whatever follows the body is the timeout;
 * - except that an inline function in third place makes the second argument an options variable.
 *   The guard cannot read through a variable, so it counts as a spelling: inline the options.
 */
function timeoutSpellings(test) {
  const [, second, third] = test.arguments;
  const options = test.arguments
    .filter(ts.isObjectLiteralExpression)
    .flatMap((object) => object.properties.filter(isTimeoutOption));
  if (!second || ts.isObjectLiteralExpression(second) || !third) return options;
  if (isFunction(third)) return [...options, second];
  return ts.isObjectLiteralExpression(third) ? options : [...options, third];
}

/** Every line of `source` where a test spells a timeout of its own, 1-based and ascending. */
function perTestTimeouts(source, fileName) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && declaresTest(node)) {
      for (const spelling of timeoutSpellings(node)) {
        lines.add(
          file.getLineAndCharacterOfPosition(spelling.getStart(file)).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}

/** Tracked and unignored untracked files matching `pathspecs`, NUL-separated so any name survives. */
function gitFiles(...pathspecs) {
  const out = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...pathspecs,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

/**
 * A listed test file's text. `git ls-files --cached` still lists a file deleted from the working
 * tree, and only that file (`ENOENT`) is skipped: a read that fails any other way throws naming
 * the file, so an unreadable file can never read as one with no offenders.
 */
function readTestFile(root, file) {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${error.message}`, { cause: error });
  }
}

// One line per case; a line that must be flagged ends in the marker, so a spelling that moves
// keeps its expectation beside it. Held in strings, so this file holds no timeout of its own.
const FLAGGED = "// FLAGGED";
const PLANTED = [
  'it("trailing number", () => {}, 5_000); // FLAGGED',
  'test("test, not it", () => {}, 5_000); // FLAGGED',
  'it("wrapped trailing number", () => {',
  "  expect(1).toBe(1);",
  "}, 5_000); // FLAGGED",
  'it("option", { timeout: 5_000 }, () => {}); // FLAGGED',
  'it("option on its own line",',
  "  { timeout: 5_000 }, // FLAGGED",
  "  () => {});",
  'it("shorthand option", { timeout }, () => {}); // FLAGGED',
  'it.each([1, 2])("each %s", () => {}, 5_000); // FLAGGED',
  'it.each([1, 2])("each option %s", { timeout: 5_000 }, () => {}); // FLAGGED',
  'it.skipIf(true)("skipIf", () => {}, 5_000); // FLAGGED',
  "it.each`",
  "  a | b",
  '`("tagged table",() => {}, 5_000); // FLAGGED',
  'it("named body", handler, 5_000); // FLAGGED',
  'it("member body", suite.body, 5_000); // FLAGGED',
  'it.each([1, 2])("each named body", handler, 5_000); // FLAGGED',
  "const slow = (name, fn) => it(name, fn, 120_000); // FLAGGED",
  'it("options, then a named body", { retry: 2 }, handler);',
  'it("named body, no timeout", handler);',
  'it("options variable, then an inline body", options, () => {}); // FLAGGED',
  'it.each([1, 2])("each options variable %s", SLOW, () => {}); // FLAGGED',
  'it("inline body, options object", () => {}, { retry: 2 });',
  "beforeAll(() => {}, 120_000);",
  "afterAll(() => {}, 120_000);",
  "beforeEach(() => {}, 120_000);",
  "afterEach(() => {}, 120_000);",
  'describe("with an option", { timeout: 60_000 }, () => {',
  '  it("inherits", () => {});',
  '  it.each([1, 2])("each inherits %s", () => {});',
  "});",
  "expect.poll(() => 1, { timeout: 2_000 });",
];

describe("no per-test timeout in any test file", { timeout: 60_000 }, () => {
  it("finds every spelling of a test's own timeout, and passes hooks, describe options and polls", () => {
    const flagged = PLANTED.flatMap((line, at) =>
      line.endsWith(FLAGGED) ? [at + 1] : [],
    );
    expect(flagged).toHaveLength(16);
    expect(perTestTimeouts(PLANTED.join("\n"), "planted.test.ts")).toEqual(
      flagged,
    );
  });

  it("holds for every test file under packages and scripts", () => {
    const files = gitFiles(...TEST_FILES);
    const packages = new Set(
      gitFiles("packages")
        .map((file) => file.split("/"))
        .filter((parts) => parts.length > 2)
        .map(([, name]) => `packages/${name}`),
    );
    const unscanned = ["scripts", ...packages].filter(
      (dir) => !files.some((file) => file.startsWith(`${dir}/`)),
    );
    expect(unscanned).toEqual([]);

    const offenders = files.flatMap((file) => {
      const source = readTestFile(REPO_ROOT, file);
      if (source === undefined) return [];
      return perTestTimeouts(source, file).map((line) => `${file}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it("skips a file deleted from the working tree and throws, naming it, on any other unreadable file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "no-per-test-timeout-"));
    try {
      writeFileSync(path.join(root, "readable.test.ts"), "// readable");
      mkdirSync(path.join(root, "a-directory.test.ts"));

      expect(readTestFile(root, "readable.test.ts")).toBe("// readable");
      expect(readTestFile(root, "deleted.test.ts")).toBeUndefined();
      expect(() => readTestFile(root, "a-directory.test.ts")).toThrow(
        "cannot read a-directory.test.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
