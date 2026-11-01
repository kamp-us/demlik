import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../test-helpers/ratchet-repo.js";
import { SMELL_LEDGER_FILENAME } from "./ledger.js";

// A source file `big-file` measures at exactly `count` lines, none of them a function. It ends
// without a newline: the measure counts the empty line after a final newline as one more.
const linesFile = (count: number): string =>
  Array.from({ length: count }, (_, i) => `export const v${i} = ${i};`).join("\n");

// A function of `body + 2` lines, over the default `longFunctionLoc` (60) when `body` is.
const longFunction = (name: string, body: number): string =>
  [
    `export function ${name}(): number {`,
    "  let total = 0;",
    ...Array.from({ length: body - 2 }, (_, i) => `  total += ${i};`),
    "  return total;",
    "}",
  ].join("\n");

const TSCONFIG =
  '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" }, "include": ["src"] }\n';

// The repo of the first criterion: `packages/core` with 60 small files, five big files and three
// long functions; `packages/other` with one 700-line file. The ledger gates only `big-file`.
function coreRepoFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": '{ "name": "fixture-root", "private": true }\n',
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "packages/core/package.json": '{ "name": "core", "private": true }\n',
    "packages/core/tsconfig.json": TSCONFIG,
    "packages/core/src/long.ts": `${["alpha", "beta", "gamma"].map((name) => longFunction(name, 70)).join("\n\n")}\n`,
    "packages/other/package.json": '{ "name": "other", "private": true }\n',
    "packages/other/src/big.ts": linesFile(700),
  };
  for (let i = 0; i < 60; i += 1) {
    files[`packages/core/src/small/s${i}.ts`] = linesFile(5);
  }
  for (const size of [450, 620, 900, 1200, 2100]) {
    files[`packages/core/src/big${size}.ts`] = linesFile(size);
  }
  return files;
}

type Entry = { rule: string; target: string; value: number; reason: string };

let top: string;
let core: string;
let ledgerFile: string;

const write = (relative: string, text: string): void => {
  const file = path.join(top, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const writeLedger = (gated: string[], entries: Entry[] = []): void => {
  fs.writeFileSync(ledgerFile, `${JSON.stringify({ gated, entries }, null, 2)}\n`);
};
const ledgerText = (): string => fs.readFileSync(ledgerFile, "utf8");
const readEntries = (): Entry[] => JSON.parse(ledgerText()).entries;
const big = (size: number): string => `packages/core/src/big${size}.ts`;
const REASON = "split in the core sweep";

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-smell-ledger-")));
  execFileSync("git", ["init", "--quiet"], { cwd: top });
  for (const [relative, text] of Object.entries(coreRepoFiles())) write(relative, text);
  core = path.join(top, "packages", "core");
  ledgerFile = path.join(top, SMELL_LEDGER_FILENAME);
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

describe("a file size gate switched on at today's count", () => {
  it("records today's big files once, then lets them only shrink", () => {
    writeLedger(["big-file"]);

    const accept = runCli([core, "--accept-smells", "--reason", REASON]);
    expect(accept.code).toBe(0);
    expect(readEntries()).toEqual(
      [1200, 2100, 450, 620, 900].map((size) => ({
        rule: "big-file",
        target: big(size),
        value: size,
        reason: REASON,
      })),
    );
    expect(ledgerText()).not.toContain("long-function");

    const recorded = ledgerText();
    for (let run = 0; run < 2; run += 1) {
      const ci = runCli([core, "--ci"]);
      expect(ci.code).toBe(0);
      expect(ci.stdout).toContain("smell ledger: PASS");
      expect(ledgerText()).toBe(recorded);
    }

    write("packages/core/src/fresh.ts", linesFile(401));
    const fresh = runCli([core, "--ci"]);
    expect(fresh.code).toBe(1);
    expect(fresh.stdout).toContain("big-file  packages/core/src/fresh.ts  401");
    expect(fresh.stdout).not.toMatch(/big\d+\.ts/);
    fs.rmSync(path.join(core, "src", "fresh.ts"));

    write(big(900), linesFile(950));
    const grown = runCli([core, "--ci"]);
    expect(grown.code).toBe(1);
    expect(grown.stdout).toContain(`big-file  ${big(900)}  recorded 900, measured 950`);

    write(big(900), linesFile(850));
    const shrunk = runCli([core, "--ci"]);
    expect(shrunk.code).toBe(0);
    expect(shrunk.stdout).toContain(`big-file  ${big(900)}  recorded 900, measured 850`);
    expect(readEntries().find((entry) => entry.target === big(900))?.value).toBe(850);

    write(big(900), linesFile(900));
    expect(runCli([core, "--ci"]).code).toBe(1);
    write(big(900), linesFile(850));

    write(big(2100), linesFile(300));
    const cut = runCli([core, "--ci"]);
    expect(cut.code).toBe(0);
    expect(cut.stdout).toContain("pruned 1 entry");
    expect(cut.stdout).toContain(`big-file  ${big(2100)}  2100`);
    expect(readEntries().map((entry) => entry.target)).toEqual([
      big(1200),
      big(450),
      big(620),
      big(900),
    ]);
  });

  it("fails a warn-severity smell like a high one, and prints the verdict as JSON", () => {
    writeLedger(
      ["big-file"],
      [
        { rule: "big-file", target: big(900), value: 800, reason: "kept" },
        { rule: "big-file", target: big(2100), value: 2100, reason: "kept" },
        { rule: "big-file", target: "packages/core/src/gone.ts", value: 500, reason: "kept" },
      ],
    );
    fs.rmSync(path.join(core, "src", "big450.ts"));
    fs.rmSync(path.join(core, "src", "big620.ts"));
    fs.rmSync(path.join(core, "src", "big1200.ts"));
    write("packages/core/src/fresh.ts", linesFile(401));

    const run = runCli([core, "--ci", "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      passed: false,
      scope: "packages/core",
      gated: ["big-file"],
      unrecorded: [{ rule: "big-file", target: "packages/core/src/fresh.ts", value: 401 }],
      worsened: [{ rule: "big-file", target: big(900), recorded: 800, measured: 900 }],
      lowered: [],
      pruned: [
        { rule: "big-file", target: "packages/core/src/gone.ts", value: 500, reason: "kept" },
      ],
    });
  });
});

describe("an entry is keyed by rule and repo-relative target", () => {
  it("keeps a long function recorded when lines are added above it", () => {
    writeLedger(["long-function"]);
    expect(runCli([core, "--accept-smells", "--reason", REASON]).code).toBe(0);
    expect(readEntries().map((entry) => entry.target)).toEqual([
      "packages/core/src/long.ts:alpha",
      "packages/core/src/long.ts:beta",
      "packages/core/src/long.ts:gamma",
    ]);
    const recorded = ledgerText();

    const longFile = path.join(core, "src", "long.ts");
    fs.writeFileSync(
      longFile,
      `// a header\n// added above\n\n${fs.readFileSync(longFile, "utf8")}`,
    );
    expect(runCli([core, "--ci"]).code).toBe(0);
    expect(ledgerText()).toBe(recorded);
  });

  it("gives the same verdict on packages/core from the repo root and from the package", () => {
    writeLedger(["big-file"]);
    expect(runCli([top, "--accept-smells", "--reason", REASON]).code).toBe(0);
    expect(readEntries()).toHaveLength(6);
    expect(runCli([top, "--ci"]).code).toBe(0);
    expect(runCli([core, "--ci"]).code).toBe(0);

    write("packages/core/src/fresh.ts", linesFile(401));
    write(big(900), linesFile(950));
    const verdicts = [top, core].map((root) => {
      const run = runCli([root, "--ci", "--json"]);
      expect(run.code).toBe(1);
      const { unrecorded, worsened } = JSON.parse(run.stdout);
      return { unrecorded, worsened };
    });
    expect(verdicts[0]).toEqual(verdicts[1]);
    expect(verdicts[0]?.unrecorded).toEqual([
      { rule: "big-file", target: "packages/core/src/fresh.ts", value: 401 },
    ]);
  });

  it("leaves an entry under another package untouched", () => {
    const other: Entry = {
      rule: "big-file",
      target: "packages/other/src/big.ts",
      value: 700,
      reason: "kept",
    };
    writeLedger(["big-file"], [other]);
    write("packages/other/src/big.ts", linesFile(10));
    expect(runCli([core, "--accept-smells", "--reason", REASON]).code).toBe(0);
    expect(runCli([core, "--ci"]).code).toBe(0);
    expect(readEntries()).toContainEqual(other);
  });
});

describe("the repo names the rules it gates", () => {
  it("gives today's --ci, output and exit code alike, when no rule is named", () => {
    const plain = [
      runCli([core, "--ci"]),
      runCli([core, "--ci", "--fail-on", "warn", "--max", "3"]),
    ];
    writeLedger([], [{ rule: "big-file", target: big(900), value: 900, reason: "kept" }]);
    const named = [
      runCli([core, "--ci"]),
      runCli([core, "--ci", "--fail-on", "warn", "--max", "3"]),
    ];
    expect(named).toEqual(plain);
    expect(plain[0]?.stdout).toContain("code-graph CI: FAIL — 4 high-severity smells.");
    expect(plain[1]?.stdout).toContain("exceed --max 3");
  });

  it("neither records nor fails a smell of a rule it did not name", () => {
    writeLedger(["big-file"]);
    expect(runCli([core, "--accept-smells", "--reason", REASON]).code).toBe(0);
    write("packages/core/src/longer.ts", `${longFunction("delta", 200)}\n`);
    const run = runCli([core, "--ci"]);
    expect(run.code).toBe(0);
    expect(ledgerText()).not.toContain("long-function");
  });

  it("exits 2 with one line naming a rule that is not one", () => {
    writeLedger(["big-files"]);
    const run = runCli([core, "--ci"]);
    expect(run.code).toBe(2);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain('"big-files" is not a smell rule');
  });
});

describe("refusals exit 2, print one line and write nothing", () => {
  it.each([
    ["--accept-smells without --reason", ["--accept-smells"]],
    ["--accept-smells with a blank --reason", ["--accept-smells", "--reason", "  "]],
    ["--accept-smells with --ci", ["--accept-smells", "--ci", "--reason", REASON]],
    ["--accept-smells with --boundaries", ["--accept-smells", "--boundaries", "--reason", REASON]],
  ])("%s", (_, flags) => {
    writeLedger(["big-file"]);
    const before = ledgerText();
    const run = runCli([core, ...flags]);
    expect(run.code).toBe(2);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stdout).toBe("");
    expect(ledgerText()).toBe(before);
  });

  it("--accept-smells when no rule is gated", () => {
    const run = runCli([core, "--accept-smells", "--reason", REASON]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("no smell rule is gated");
    expect(fs.existsSync(ledgerFile)).toBe(false);
  });

  it.each([
    ["unreadable JSON", "{ not json"],
    ["a schema-invalid ledger", '{ "gated": ["big-file"], "entries": [{ "rule": "big-file" }] }\n'],
  ])("an %s", (_, text) => {
    fs.writeFileSync(ledgerFile, text);
    for (const flags of [["--ci"], ["--accept-smells", "--reason", REASON]]) {
      const run = runCli([core, ...flags]);
      expect(run.code).toBe(2);
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).toContain(ledgerFile);
      expect(ledgerText()).toBe(text);
    }
  });
});

// `high-fan-in` is measured only by the edge pass: one function called from eleven files.
describe("a gated edge-pass rule", () => {
  beforeEach(() => {
    write(
      "packages/core/src/shared.ts",
      "export function shared(n: number): number {\n  return n;\n}\n",
    );
    for (let i = 0; i < 11; i += 1) {
      write(
        `packages/core/src/callers/c${i}.ts`,
        `import { shared } from "../shared.js";\n\nexport function call${i}(): number {\n  return shared(${i});\n}\n`,
      );
    }
  });

  it("turns the edge pass on, so its entries are measured rather than pruned", () => {
    writeLedger(["high-fan-in"]);
    expect(runCli([core, "--accept-smells", "--reason", REASON]).code).toBe(0);
    expect(readEntries()).toEqual([
      {
        rule: "high-fan-in",
        target: "packages/core/src/shared.ts:shared",
        value: 11,
        reason: REASON,
      },
    ]);
    const recorded = ledgerText();
    expect(runCli([core, "--ci"]).code).toBe(0);
    expect(ledgerText()).toBe(recorded);

    write(
      "packages/core/src/callers/c11.ts",
      'import { shared } from "../shared.js";\n\nexport function call11(): number {\n  return shared(11);\n}\n',
    );
    const grown = runCli([core, "--ci"]);
    expect(grown.code).toBe(1);
    expect(grown.stdout).toContain("recorded 11, measured 12");
  });
});
