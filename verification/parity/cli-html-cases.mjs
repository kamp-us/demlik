import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { reportsFixture } from "./cli-reports-cases.mjs";
import { put } from "./collapse-gate-cases.mjs";

export function htmlFixture(location, options) {
  const f = reportsFixture(location, {
    ...options,
    target: "packages/billing",
  });
  f.target = options.target ?? f.target;
  for (const pkg of [f.physical, "packages/second"]) {
    for (const name of fs.readdirSync(path.join(f.root, pkg)))
      if (/\.tsx?$/.test(name)) fs.rmSync(path.join(f.root, pkg, name));
    if (options.empty) continue;
    if (pkg === f.physical) {
      put(
        f.root,
        `${pkg}/hub.ts`,
        "import {neighbor} from './neighbor.js';\nexport function hub(n:number){return neighbor(n);}\n",
      );
      put(
        f.root,
        `${pkg}/caller.ts`,
        "import {hub} from './hub.js';\nexport function caller(n:number){\n const a=hub(n);\n const b=hub(a);\n return hub(b);\n}\n",
      );
      put(
        f.root,
        `${pkg}/neighbor.ts`,
        "import {remote} from './remote.js';\nexport function neighbor(n:number){return remote(n);}\n",
      );
      put(
        f.root,
        `${pkg}/remote.ts`,
        "export function remote(n:number){return n;}\n",
      );
      put(
        f.root,
        `${pkg}/smelly.ts`,
        "export function smelly(n:number){\n if(n>0){if(n>1){if(n>2)return 3;return 2;}return 1;}return 0;\n}\n",
      );
      put(f.root, `${pkg}/plain.ts`, "export function plain(){return 0;}\n");
    } else {
      put(
        f.root,
        `${pkg}/external.ts`,
        "import {hub} from '../billing/hub.js';\nexport function external(n:number){return hub(n);}\n",
      );
    }
  }
  put(
    f.root,
    "thresholds.json",
    JSON.stringify({
      highComplexity: 2,
      dependencyCycle: 100,
      crossBoundaryImports: 100,
    }),
  );
  if (options.workflow) {
    put(f.root, "report.html", "previous report\n");
    fs.chmodSync(path.join(f.root, "report.html"), 0o640);
  }
  return f;
}
const html = { mode: "html", flags: ["--html"], exit: 0 };
export const htmlSteps = [
  { id: "write", flags: ["--html"], out: "report.html", mode: "html" },
  {
    id: "repeat-json-pretty",
    flags: ["--html", "--json", "--pretty"],
    out: "report.html",
    mode: "html",
  },
  { id: "stdout", flags: ["--html"], mode: "html" },
];
export const htmlCliCases = [
  ["html-real-hub", { ...html }],
  [
    "html-json-pretty-ignored",
    { ...html, flags: ["--html", "--json", "--pretty"] },
  ],
  [
    "html-wins-late-modes",
    {
      ...html,
      flags: [
        "--html",
        "--graph",
        "--blast",
        "never",
        "--find",
        "never",
        "--hotspots",
        "--hotspots-days",
        "bad",
      ],
    },
  ],
  [
    "html-by-warning",
    {
      ...html,
      flags: ["--html", "--by", "impact"],
      warning: "warning: --by impact has no effect without --plan.",
    },
  ],
  [
    "html-losing-plan-suppresses-warning",
    { ...html, flags: ["--html", "--plan", "--by", "bogus"] },
  ],
  [
    "html-losing-collapse-analysis",
    { ...html, flags: ["--html", "--collapse", "--headers"] },
  ],
  ["html-data-and-kinds", { ...html, flags: ["--html", "--data", "--kinds"] }],
  ["html-deep-package-visible-scope", { ...html, flags: ["--html", "--deep"] }],
  [
    "html-deep-two-packages",
    { ...html, target: ".", flags: ["--html", "--deep"], wholeRepo: true },
  ],
  ["html-empty-project", { ...html, empty: true }],
  ["html-real-file-overwrite-workflow", { ...html, workflow: true }],
  [
    "html-initial-exit-preserved",
    { ...html, out: "kept.html", outMode: 0o640, initial: 7, exit: 7 },
  ],
  [
    "html-load-refusal-before-output",
    {
      flags: ["--html", "--out", "unwritten.html"],
      noConfig: true,
      loadRefused: true,
      exit: 2,
    },
  ],
  [
    "ci-wins-html-edge-pass",
    { flags: ["--ci", "--html"], mode: "ci", exit: 1 },
  ],
  [
    "prepared-smell-wins-html",
    {
      flags: ["--ci", "--html"],
      preparedSmell: true,
      early: "smell-ledger",
      exit: 1,
    },
  ],
  [
    "comments-win-html-no-compiler",
    {
      flags: ["--comments", "--html"],
      cheap: true,
      withoutCompiler: true,
      early: "comments",
      exit: 0,
    },
  ],
  [
    "html-write-failure",
    {
      ...html,
      out: "directory-out",
      outDirectory: true,
      exception: true,
      exit: 1,
    },
  ],
  [
    "html-warning-before-write-failure",
    {
      ...html,
      flags: ["--html", "--by", "impact"],
      out: "directory-out",
      outDirectory: true,
      exception: true,
      warning: "warning: --by impact",
      exit: 1,
    },
  ],
  ["html-pending-stdout", { ...html, badStdout: true, pending: true, exit: 1 }],
  [
    "html-file-before-pending-banner",
    { ...html, out: "written.html", badStderr: true, pending: true, exit: 1 },
  ],
];

export function htmlLiteral(text, options, step, run) {
  const expected = { ...options, ...step };
  assert.ok(text.startsWith("<!doctype html>\n"));
  assert.ok(text.endsWith("</html>\n") && !text.endsWith("</html>\n\n"));
  const begin = text.indexOf("const DATA = ") + "const DATA = ".length;
  const end = text.indexOf("\nconst COLOR = ", begin);
  assert.ok(begin > 12 && end > begin);
  const model = JSON.parse(text.slice(begin, end).trim().replace(/;$/, ""));
  assert.ok(
    !text.slice(begin, end).includes('\n    "'),
    "DATA is compact even with --pretty",
  );
  assert.ok(
    text.includes("d3@7/dist/d3.min.js") && text.includes("cytoscape@3.30.2"),
  );
  if (expected.empty) {
    assert.equal(model.summary.functionCount, 0);
    assert.equal(model.graph.hiddenCount, 0);
    return;
  }
  assert.ok(model.summary.fileCount > 2);
  assert.ok(model.summary.functionCount >= 6);
  const hub = model.graph.nodes.find((n) => n.label === "hub");
  assert.ok(hub && hub.fanIn === (expected.wholeRepo ? 4 : 3));
  assert.equal(
    model.plan.find((n) => n.id === hub.id).calledByCount,
    expected.wholeRepo ? 2 : 1,
  );
  assert.ok(
    model.graph.nodes.some((n) => n.label === "neighbor" && n.hidden === true),
  );
  assert.ok(!model.graph.nodes.some((n) => n.label === "plain"));
  if (!expected.wholeRepo)
    assert.ok(!model.graph.nodes.some((n) => n.label === "remote"));
  if (expected.flags.includes("--plan"))
    assert.ok(!run.output.stderr.includes("warning:"));
}
