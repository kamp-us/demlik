import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCOPE = "packages/app";

const SOURCES: Readonly<Record<string, string>> = {
  // An unledgered dead export.
  "src/dead.ts": "export function unused(n: number): number {\n  return n + 1;\n}\n",
  // An undeclared upward layer edge: `domain` sits below `shell`.
  "src/shell/high.ts": "export const high = 1;\n",
  "src/domain/low.ts": 'import { high } from "../shell/high.js";\n\nexport const low = high;\n',
  // A new boundary crossing: `orders` reaches past `billing`'s index.
  "src/billing/index.ts": 'export { charge } from "./charge.js";\n',
  "src/billing/charge.ts": "export const charge = 1;\n",
  "src/orders/index.ts": 'export { place } from "./place.js";\n',
  "src/orders/place.ts":
    'import { charge } from "../billing/charge.js";\n\nexport const place = charge;\n',
  // A comment count over its ceiling of zero.
  "src/commented.ts":
    "// One line of prose that says why this constant exists.\nexport const commented = 1;\n",
  // A partial twin over the collapse ceiling of zero: one decision prologue, two endings.
  "src/twins.ts": [
    "export const MAX_ATTEMPTS = 3;",
    "function noteAttempt(): void {}",
    "function decide(limit: number): boolean {",
    "  return limit > 1;",
    "}",
    "function record(): void {}",
    "function finalizeFailed(): void {}",
    "function degradeToPartial(): void {}",
    "export function giveUp(n: number): void {",
    "  noteAttempt();",
    "  decide(MAX_ATTEMPTS);",
    "  record();",
    "  if (n > 0) {",
    "    finalizeFailed();",
    "  }",
    "}",
    "export function salvage(n: number): void {",
    "  noteAttempt();",
    "  decide(MAX_ATTEMPTS);",
    "  record();",
    "  if (n > 0) {",
    "    degradeToPartial();",
    "  }",
    "}",
    "",
  ].join("\n"),
  // A smell of a gated rule the smell ledger does not name.
  "src/big.ts": Array.from({ length: 700 }, (_, i) => `const v${i} = ${i};`).join("\n"),
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// Every ledger and ceilings file. Each ledger keeps an entry whose finding is gone, so a gate that
// ran would prune it and change the file's bytes.
const LEDGERS: Readonly<Record<string, string>> = {
  "unreachable-ledger.json": json({
    entries: [{ scope: SCOPE, kind: "dead", id: "src/gone.ts:gone", reason: "kept" }],
  }),
  "smell-ledger.json": json({
    gated: ["big-file"],
    entries: [{ rule: "big-file", target: `${SCOPE}/src/gone.ts`, value: 900, reason: "kept" }],
  }),
  "boundary-ledger.json": json({
    entries: [
      {
        scope: SCOPE,
        kind: "cross-feature",
        from: "src/orders/gone.ts",
        to: "src/billing/gone.ts",
        specifier: "../billing/gone.js",
        reason: "kept",
      },
    ],
  }),
  "comment-ceilings.json": json({ default: 0, slackPoints: 0, scopes: {} }),
  "collapse-ceilings.json": json({ default: 0, scopes: { [SCOPE]: 0 } }),
};

export const LEDGER_FILES: readonly string[] = Object.keys(LEDGERS);

export type FiveGateRepo = {
  readonly top: string;
  // The package every gate runs on.
  readonly app: string;
  // The flags that name each gate, its rules file included where it needs one.
  readonly gates: {
    readonly layers: readonly string[];
    readonly boundaries: readonly string[];
    readonly comments: readonly string[];
    readonly collapse: readonly string[];
    readonly unreachable: readonly string[];
  };
  // Every ledger and ceilings file's text, by file name.
  readonly ledgers: () => Readonly<Record<string, string>>;
  readonly dispose: () => void;
};

// One repo on which each of the five named gates, and the plain `--ci` smell gate, fails alone.
export function fiveGateRepo(): FiveGateRepo {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-five-gates-")));
  const app = path.join(top, SCOPE);
  const write = (relative: string, text: string): void => {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  execFileSync("git", ["init", "--quiet"], { cwd: top });
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(`${SCOPE}/package.json`, '{ "name": "app", "private": true }\n');
  write(
    `${SCOPE}/tsconfig.json`,
    '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" }, "include": ["src"] }\n',
  );
  for (const [relative, text] of Object.entries(SOURCES)) write(`${SCOPE}/${relative}`, text);
  for (const [name, text] of Object.entries(LEDGERS)) write(name, text);

  const layerRules = path.join(top, "layer-rules.json");
  fs.writeFileSync(
    layerRules,
    json({
      layers: [
        { name: "shell", paths: [`${SCOPE}/src/shell`] },
        { name: "domain", paths: [`${SCOPE}/src/domain`] },
      ],
    }),
  );
  const boundaryRules = path.join(top, "boundary-rules.json");
  fs.writeFileSync(boundaryRules, json({ features: { [SCOPE]: ["billing", "orders"] } }));

  return {
    top,
    app,
    gates: {
      layers: ["--layers", "--layer-rules", layerRules],
      boundaries: ["--boundaries", "--ci", "--boundary-rules", boundaryRules],
      comments: ["--comments", "--ci"],
      collapse: ["--collapse", "--ci"],
      unreachable: ["--unreachable", "--ci"],
    },
    ledgers: () =>
      Object.fromEntries(
        LEDGER_FILES.map((name) => [name, fs.readFileSync(path.join(top, name), "utf8")]),
      ),
    dispose: () => {
      fs.rmSync(top, { recursive: true, force: true });
    },
  };
}
