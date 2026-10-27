import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportsFixture } from "./cli-reports-cases.mjs";
import { put } from "./collapse-gate-cases.mjs";

export function tailFixture(location, o) {
  const f = reportsFixture(location, { ...o, target: "packages/billing" });
  for (const pkg of [f.physical, "packages/second"]) {
    for (const name of fs.readdirSync(path.join(f.root, pkg)))
      if (/\.tsx?$/.test(name)) fs.rmSync(path.join(f.root, pkg, name));
    if (o.empty) continue;
    if (pkg === f.physical) {
      put(
        f.root,
        `${pkg}/core.ts`,
        "export interface Shared { value:number }\nexport function target(n:number):number {\n if(n<=0)return 0;\n const first=target(n-1);\n return first+target(n-2);\n}\nexport function Shared(n:number){ return n+1; }\nexport const TOKEN=3;\n",
      );
      put(
        f.root,
        `${pkg}/left.ts`,
        "import {target, Shared} from './core.js';\nexport function left(n:number){return target(n)+Shared(n)+target(n)+Shared(n);} export function alsoLeft(n:number){return Shared(n);}\nexport type Alias=Shared;\n",
      );
      put(
        f.root,
        `${pkg}/right.ts`,
        "import {target} from './core.js';\nexport function right(n:number){return target(n);}\n",
      );
      put(
        f.root,
        `${pkg}/entry.ts`,
        "import {left} from './left.js';\nimport {right} from './right.js';\nexport function outer(n:number){return left(n)+right(n);}\nexport function duplicate(){return 0;}\n",
      );
      put(
        f.root,
        `${pkg}/spare.ts`,
        "export function duplicate(){return 1;}\n",
      );
      put(
        f.root,
        `${pkg}/core.test.ts`,
        "import {Shared} from './core.js';\nexport function testShared(){return Shared(1);}\n",
      );
      if (o.ansi || o.styles)
        put(
          f.root,
          `${pkg}/style\u001b[39m.ts`,
          'export class Styles {\n "name\u001b[22m tail"(n:number){if(n)return 1;return 0;}\n [\r\n  "line"\r\n ](n:number){if(n)return 1;return 0;}\n}\nexport function 𐐀(){return 0;}\n',
        );
    } else {
      put(
        f.root,
        `${pkg}/external.ts`,
        "import {target} from '../billing/core.js';\nexport function external(n:number){return target(n);}\nexport function duplicate(){return 2;}\nexport interface Shared { label:string }\n",
      );
    }
  }
  if (o.cheap || o.noConfig) {
    for (const file of [
      "tsconfig.json",
      `${f.physical}/tsconfig.json`,
      "packages/second/tsconfig.json",
    ])
      fs.rmSync(path.join(f.root, file), { force: true });
  }
  if (o.parseFailure)
    put(f.root, `${f.physical}/broken.ts`, "export function lost( {\n");
  if (o.ansi || o.styles)
    put(
      f.root,
      "thresholds.json",
      JSON.stringify({ highComplexity: 0, longFunctionLoc: 1000 }),
    );
  f.target = o.target ?? f.target;
  return f;
}
const tree = {
  mode: "tail",
  tailView: "tree",
  cheap: true,
  withoutCompiler: true,
};
const blast = {
  mode: "tail",
  tailView: "blast",
  flags: ["--blast", "core.ts:target", "--json"],
};
const find = { mode: "tail", tailView: "find", flags: ["--find", "Shared"] };
export const tailCases = [
  ["tree-cheap-no-compiler", { ...tree, flags: ["--tree"] }],
  ["tree-ansi-unicode-lines", { ...tree, flags: ["--tree"], ansi: true }],
  [
    "tree-plain-preserves-raw-codes",
    { ...tree, flags: ["--tree"], styles: true },
  ],
  [
    "tree-json-pretty-headers",
    {
      ...tree,
      tailView: "graph",
      flags: ["--tree", "--json", "--pretty", "--headers"],
    },
  ],
  [
    "tree-empty-modules",
    { ...tree, tailView: "empty", flags: ["--tree"], empty: true },
  ],
  [
    "tree-file-mode-and-initial-exit",
    {
      ...tree,
      flags: ["--tree"],
      out: "tree.txt",
      outMode: 0o640,
      initial: 7,
      exit: 7,
    },
  ],
  [
    "file-wins-tree",
    { ...tree, tailView: "file", flags: ["--tree", "--file", "core.ts"] },
  ],
  [
    "smells-wins-tree",
    { ...tree, tailView: "smells", flags: ["--tree", "--smells"] },
  ],
  [
    "graph-wins-query-but-keeps-edge-load",
    {
      mode: "tail",
      tailView: "graph",
      pass: "edges",
      flags: ["--graph", "--blast", "never", "--tree"],
    },
  ],
  [
    "hexagon-wins-query-without-compiler",
    {
      flags: ["--hexagon", "--blast", "never"],
      cheap: true,
      withoutCompiler: true,
      early: "hexagon",
    },
  ],
  [
    "ordinary-ci-wins-query",
    { flags: ["--ci", "--blast", "never"], mode: "ci", exit: 0 },
  ],
  [
    "losing-query-still-needs-config",
    {
      flags: ["--graph", "--find", "Shared"],
      noConfig: true,
      loadRefused: true,
      exit: 2,
    },
  ],
  ["blast-diamond-recursion-package-json", { ...blast }],
  [
    "blast-deep-pretty-keeps-initial-exit",
    {
      ...blast,
      target: ".",
      flags: ["--blast", "target", "--deep", "--json", "--pretty"],
      initial: 7,
      exit: 7,
    },
  ],
  ["blast-human-recursion", { ...blast, flags: ["--blast", "core.ts:target"] }],
  ["blast-bare-name", { ...blast, flags: ["--blast", "target", "--json"] }],
  [
    "blast-ambiguous-no-output-write",
    {
      mode: "tail",
      tailView: "ambiguous",
      flags: ["--blast", "duplicate"],
      out: "unused.json",
      exit: 1,
    },
  ],
  [
    "blast-missing-parse-failure-hint",
    {
      mode: "tail",
      tailView: "missing",
      flags: ["--blast", "broken.ts:lost"],
      parseFailure: true,
      exit: 1,
      warning: "its file is in parseFailures",
    },
  ],
  [
    "blast-empty-query-is-present",
    { mode: "tail", tailView: "missing", flags: ["--blast", ""], exit: 1 },
  ],
  [
    "blast-no-config-refuses-before-query",
    { flags: ["--blast", "never"], noConfig: true, loadRefused: true, exit: 2 },
  ],
  [
    "blast-wins-find-and-tree",
    {
      ...blast,
      flags: ["--blast", "target", "--find", "Shared", "--tree", "--json"],
    },
  ],
  [
    "blast-warning-before-file-failure",
    {
      ...blast,
      out: "directory-out",
      outDirectory: true,
      exception: true,
      initial: 7,
    },
  ],
  [
    "blast-warning-output-pending-stdout",
    { ...blast, badStdout: true, pending: true, exit: 1 },
  ],
  ["find-shared-function-and-type", { ...find }],
  [
    "find-pretty-uses-and-losing-tree",
    { ...find, flags: ["--find", "Shared", "--tree", "--pretty"] },
  ],
  ["find-deep-all-matches", { ...find, flags: ["--find", "Shared", "--deep"] }],
  [
    "find-no-match-empty-data-keeps-exit",
    {
      ...find,
      tailView: "find-empty",
      flags: ["--find", "Absent"],
      initial: 7,
      exit: 7,
    },
  ],
  [
    "find-no-config-refuses",
    { flags: ["--find", "Shared"], noConfig: true, loadRefused: true, exit: 2 },
  ],
  [
    "find-warning-before-file-and-banner",
    {
      ...find,
      tailView: "find-empty",
      flags: ["--find", "Absent"],
      out: "find.json",
      outMode: 0o640,
      initial: 7,
      exit: 7,
    },
  ],
  [
    "find-pending-stderr-still-writes-file",
    {
      ...find,
      flags: ["--find", "Absent"],
      out: "find.json",
      badStderr: true,
      pending: true,
      exit: 1,
    },
  ],
  [
    "find-raw-query-units",
    {
      ...find,
      tailView: "find-empty",
      flags: ["--find", "raw\ud800"],
      rawPayload: true,
      rawArgv: true,
    },
  ],
  ["two-package-tail-workflow", { workflow: true, mode: "tail" }],
];
export const tailSteps = [
  { id: "tree", flags: ["--tree"], tailView: "tree" },
  {
    id: "tree-graph",
    flags: ["--tree", "--json", "--headers"],
    tailView: "graph",
  },
  { id: "blast-package", ...blast },
  {
    id: "blast-deep",
    target: ".",
    flags: ["--blast", "target", "--deep", "--json"],
    tailView: "blast",
  },
  { id: "find-shared", ...find },
  {
    id: "find-file",
    flags: ["--find", "Absent"],
    tailView: "find-empty",
    out: "find.json",
  },
  {
    id: "repeat-find-file",
    flags: ["--find", "Absent"],
    tailView: "find-empty",
    out: "find.json",
  },
];
export function tailLiteral(run, o, step, text) {
  const e = { ...o, ...step },
    view = e.tailView;
  if (view === "empty") assert.equal(text, "No modules in the graph.\n");
  if (view === "tree") {
    assert.ok(text.includes("core.ts  (loc "));
    assert.ok(text.includes("[test]"));
    assert.ok(text.includes("target"));
    if (e.ansi) {
      for (const code of ["\u001b[36m", "\u001b[1m", "\u001b[2m", "\u001b[33m"])
        assert.ok(
          text.includes(code),
          `actual tree style ${JSON.stringify(code)}`,
        );
      assert.ok(
        text.includes("\u001b[39m\u001b[36m.ts"),
        "module cyan close is reopened",
      );
      assert.ok(
        text.includes("\u001b[22m\u001b[1m tail"),
        "embedded bold close is reopened",
      );
      assert.ok(
        text.includes("\u001b[22m\r\n\u001b[1m"),
        "computed name CRLF closes/reopens",
      );
      assert.ok(
        text.includes("𐐀                  \u001b[22m"),
        "astral name has18 padding spaces",
      );
    } else if (e.styles) assert.ok(text.includes("name\u001b[22m tail"));
    else assert.equal(text.includes("\u001b"), false);
  }
  if (view === "graph") {
    const g = JSON.parse(text);
    assert.ok(
      g.modules.length > 2 && g.functions.length > 2,
      "real nonvacuous project",
    );
    assert.equal(g.provenance.pass, e.pass ?? "cheap");
    if (e.flags.includes("--headers"))
      assert.ok(g.functions.every((f) => Object.hasOwn(f, "header")));
  }
  if (view === "blast") {
    if (e.flags.includes("--json")) {
      const v = JSON.parse(text),
        deep = e.flags.includes("--deep");
      assert.equal(v.scope, deep ? "deep" : "package");
      assert.equal(v.crossPackageCallersOmitted, !deep);
      assert.equal(v.recursiveSelfCalls, 2);
      assert.equal(
        v.callers.some((r) => r.callerId === v.target),
        false,
      );
      assert.equal(
        v.callers.filter((r) => r.callerId.endsWith("left.ts:left")).length,
        1,
      );
      assert.equal(
        v.callers.find((r) => r.callerId.endsWith("left.ts:left")).line,
        2,
      );
      assert.equal(
        v.callers.find((r) => r.callerId.endsWith("entry.ts:outer")).depth,
        2,
      );
      assert.equal(
        v.callers.some((r) => r.callerId.endsWith("external.ts:external")),
        deep,
      );
    } else {
      assert.ok(text.startsWith("blast: core.ts:target\n"));
      assert.ok(text.includes("recursive: 2 self-calls"));
      assert.ok(text.includes("d2  entry.ts:outer"));
    }
  }
  if (view === "ambiguous") {
    assert.equal(run.output.stdout, "");
    assert.ok(run.output.stderr.includes("2 matches"));
    assert.ok(
      run.output.stderr.indexOf("entry.ts:duplicate") <
        run.output.stderr.indexOf("spare.ts:duplicate"),
    );
    assert.equal(run.files["unused.json"], undefined);
  }
  if (view === "missing") {
    assert.equal(run.output.stdout, "");
    assert.ok(run.output.stderr.includes("error: no function matches"));
  }
  if (view === "find" || view === "find-empty") {
    const v = JSON.parse(text);
    assert.ok(Array.isArray(v.matches));
    if (view === "find-empty") assert.deepEqual(v.matches, []);
    else {
      assert.ok(v.matches.length >= 2);
      const fn = v.matches.find((m) => m.kind === "function"),
        type = v.matches.find((m) => m.kind === "interface");
      assert.ok(fn && type);
      assert.equal(
        fn.uses.filter((s) => s.file.endsWith("left.ts") && s.line === 2)
          .length,
        1,
        "repeated physical call line deduped",
      );
      assert.ok(Array.isArray(type.uses));
    }
  }
  if (view === "file") assert.equal(JSON.parse(text).module.file, "core.ts");
  if (view === "smells") assert.equal(text, "No smells found.\n");
}
