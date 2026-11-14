import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DOCS_MAP,
  DOCS_REPORT,
  DOCS_SHAPE,
  type DocsRun,
  docsPackage,
  removePackage,
  runDocsCli,
  snapshot,
} from "./docs-package.fixture.js";

// The doc report end to end (SPEC §13.10), through the CLI entry, over the committed fixture
// package: 48 published declarations, 30 in the caller's shape, 18 out of it, 3 left out.
const IN_SHAPE = (what: string): string =>
  `/**\n * ${what}\n *\n * @stability stable\n * @category constructors\n */\n`;

let root: string;
beforeEach(() => {
  root = docsPackage();
});
afterEach(() => removePackage(root));

const report = (...extra: string[]): DocsRun =>
  runDocsCli([root, "--api", DOCS_MAP, "--api-docs", DOCS_SHAPE, ...extra]);

type Finding = { kind: string; tag?: string; before?: string };
type Declaration = {
  block: string;
  file: string;
  line: number;
  name: string;
  findings: Finding[];
  reachedBy: { subpath: string; name: string }[];
};
type Json = { judged: number; declarations: Declaration[]; gaps: unknown[] };

const lines = (stdout: string): string[] => stdout.trimEnd().split("\n");

function tempFile(name: string, value: unknown): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const replaceIn = (relative: string, from: string, to: string): void => {
  const file = path.join(root, relative);
  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain(from);
  fs.writeFileSync(file, text.replace(from, to));
};

describe("code-graph --api <map> --api-docs <shape>", { timeout: 120_000 }, () => {
  it("lists every published declaration out of shape at its source line, counts them, and exits 0", () => {
    const run = report();
    expect(run.stdout).toBe(DOCS_REPORT);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("names, on every finding line, a line of the source file that declares that name", () => {
    for (const line of lines(DOCS_REPORT).slice(0, -1)) {
      const [, file, at, name] = /^(\S+):(\d+) {2}(\S+) {2}/.exec(line) ?? [];
      const source = fs.readFileSync(path.join(root, file as string), "utf8").split("\n");
      // A name inside a namespace carries its namespaces; the line declares its last part.
      expect(source[Number(at) - 1], line).toContain((name as string).split(".").at(-1));
    }
  });

  it("prints the same bytes on a second run and writes no file", () => {
    const before = snapshot(root);
    const first = report();
    const second = report();
    expect(second.stdout).toBe(first.stdout);
    expect(snapshot(root)).toEqual(before);
  });

  it("reads source, so a tsconfig with removeComments gives the same bytes", () => {
    const file = path.join(root, "tsconfig.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.compilerOptions.removeComments = true;
    fs.writeFileSync(file, JSON.stringify(config));
    expect(report().stdout).toBe(DOCS_REPORT);
  });

  it("drops a declaration once it is documented, and lists a new one at its line", () => {
    replaceIn(
      "src/make.ts",
      "export function make",
      `${IN_SHAPE("Makes a maker.")}export function make`,
    );
    replaceIn(
      "src/labs/index.ts",
      "export function probe",
      `${IN_SHAPE("Probes the trials.")}export function probe`,
    );
    const documented = report().stdout;
    expect(documented).not.toMatch(/ {2}(make|probe) {2}/);
    expect(lines(documented).at(-1)).toBe("api docs: 48 exports judged, 16 with a finding");

    const labs = path.join(root, "src/labs/index.ts");
    const at = fs.readFileSync(labs, "utf8").split("\n").length;
    fs.appendFileSync(labs, "export function added(): number {\n  return 1;\n}\n");
    const added = report().stdout;
    expect(added).toContain(`src/labs/index.ts:${at}  added  no doc block\n`);
    expect(lines(added).at(-1)).toBe("api docs: 49 exports judged, 17 with a finding");
  });

  it("carries every finding, every reach and no absolute path in --json", () => {
    const out = report("--json").stdout;
    expect(out).not.toContain(root);
    const { judged, declarations, gaps } = JSON.parse(out) as Json;
    expect(judged).toBe(48);
    expect(gaps).toEqual([]);
    expect(declarations.map(({ file, line, name }) => `${file}:${line} ${name}`)).toEqual([
      ...new Set(
        lines(DOCS_REPORT)
          .slice(0, -1)
          .map((line) => line.split("  ").slice(0, 2).join(" ")),
      ),
    ]);
    const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
    expect(byName.get("parse")).toEqual({
      block: "export",
      file: "src/core.ts",
      findings: [{ kind: "missing-block" }],
      line: 48,
      name: "parse",
      reachedBy: [{ name: "parse", subpath: "." }],
    });
    expect(byName.get("twoBlocks")?.findings).toEqual([
      { kind: "missing-description" },
      { kind: "missing-tag", tag: "@stability" },
      { kind: "missing-tag", tag: "@category" },
    ]);
    expect(byName.get("both")?.findings).toEqual([
      { kind: "missing-tag", tag: "@category" },
      { kind: "forbidden-tag", tag: "@since" },
    ]);
    expect(byName.get("swap")?.findings).toEqual([
      { kind: "tag-out-of-order", tag: "@category", before: "@stability" },
    ]);
    expect(byName.get("sharedDefault")?.reachedBy).toEqual([
      { name: "sharedDefault", subpath: "." },
      { name: "sharedDefault", subpath: "./model" },
    ]);
    expect(byName.get("make")?.reachedBy).toEqual([{ name: "create", subpath: "." }]);
    expect(byName.get("convert")?.reachedBy).toEqual([{ name: "Units.convert", subpath: "." }]);
  });

  it("judges the members behind export * as Name when the map lists only the barrel", () => {
    const map = tempFile("barrel-map.json", { ".": { entry: "src/index.ts" } });
    const run = runDocsCli([root, "--api", map, "--api-docs", DOCS_SHAPE]);
    expect(run.stdout).toContain("src/units.ts:29  convert  no doc block\n");
    expect(lines(run.stdout).at(-1)).toBe("api docs: 29 exports judged, 14 with a finding");
  });

  it("leaves out a skipped file and a dependency's name, and judges the file once it is not skipped", () => {
    expect(report().stdout).not.toMatch(/hidden|helper|depThing/);
    const { skip: _, ...rest } = JSON.parse(fs.readFileSync(DOCS_SHAPE, "utf8"));
    const shape = tempFile("no-skip.json", rest);
    const run = runDocsCli([root, "--api", DOCS_MAP, "--api-docs", shape]);
    expect(run.stdout).toContain("src/internal/hidden.ts:1  hidden  no doc block\n");
    expect(run.stdout).toContain("src/support.test-support.ts:1  helper  no doc block\n");
    expect(run.stdout).not.toContain("depThing");
    expect(lines(run.stdout).at(-1)).toBe("api docs: 50 exports judged, 20 with a finding");
  });

  it("writes the same payload to --out and leaves stdout empty", () => {
    const out = path.join(root, "report.txt");
    const run = report("--out", out);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(fs.readFileSync(out, "utf8")).toBe(DOCS_REPORT);
  });
});
