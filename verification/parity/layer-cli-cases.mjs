import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const files = {
  "src/ui/screen.ts":
    'import { useCase } from "../service/use-case.js";\nimport type { ViewModel } from "./view-model.js";\nimport "node:fs";\nimport "./missing.js";\nexport const screen = (v: ViewModel) => useCase(v);\n',
  "src/ui/view-model.ts": "export type ViewModel = { id: string };\n",
  "src/service/use-case.ts":
    'import type { Entity } from "../domain/entity.js";\nimport type { ViewModel } from "../ui/view-model.js";\nexport const useCase = (v: ViewModel): Entity => v;\n',
  "src/service/local.ts":
    'import { useCase } from "./use-case.js";\nexport const local = useCase;\n',
  "src/domain/entity.ts": "export type Entity = { id: string };\n",
  "src/domain/store.ts":
    'import { useCase } from "../service/use-case.js";\nexport const store = useCase;\n',
};
export const layerCases = [
  ["text", {}],
  ["pretty-text", { flags: ["--pretty"] }],
  ["json", { flags: ["--json"] }],
  ["pretty-json", { flags: ["--json", "--pretty"] }],
  ["ci", { flags: ["--ci"] }],
  ["allowed-text", { allowed: true }],
  ["allowed-initial", { allowed: true, initial: 7 }],
  ["allowed-json", { allowed: true, flags: ["--json"] }],
  ["allowed-pretty", { allowed: true, flags: ["--json", "--pretty"] }],
  ["stale", { allowed: true, stale: true }],
  ["miscount", { allowed: true, miscount: true }],
  ["default-rules", { defaultRules: true }],
  ["missing-rules", { rules: "missing" }],
  ["malformed-rules", { rules: "malformed" }],
  ["tie", { tie: true }],
  [
    "later-flags",
    {
      flags: [
        "--boundaries",
        "--boundary-rules=must-not-read.json",
        "--comments",
        "--collapse",
        "--env-keys",
        "--graph",
        "--edges",
        "--deep",
        "--html",
      ],
    },
  ],
  ["ci-skips-smell-ledger", { flags: ["--ci"], badSmell: true }],
  [
    "unreachable-refusal-first",
    { flags: ["--unreachable", "--ci"], badUnreachable: true, preLayer: true },
  ],
  ["accept-dead-first", { flags: ["--accept-dead"], preLayer: true }],
  [
    "smell-conflict-first",
    { flags: ["--accept-smells", "--reason=why"], preLayer: true },
  ],
  [
    "global-config-first",
    { flags: ["--thresholds=bad.json"], badGlobal: true, preLayer: true },
  ],
  ["without-compiler", { flags: ["--edges", "--deep"], withoutCompiler: true }],
  ["malformed-tsconfig", { badTsconfig: true }],
  ["out-text", { out: "result.txt" }],
  [
    "out-pretty-unicode",
    { out: "result.json", flags: ["--json", "--pretty"], unicode: true },
  ],
  ["out-directory", { out: "packages/app", expectedThrow: true }],
  [
    "out-directory-initial",
    { out: "packages/app", initial: 7, expectedThrow: true },
  ],
  ["out-null", { out: "raw\0\ud800", rawArgv: true, expectedThrow: true }],
  ["out-banner-bad", { out: "result.txt", badStderr: true }],
  [
    "out-banner-bad-pass-initial",
    { out: "result.txt", badStderr: true, allowed: true, initial: 7 },
  ],
  ["stdout-bad", { badStdout: true }],
  ["stderr-unused", { badStderr: true, allowed: true }],
  [
    "stdout-unused-with-out",
    { badStdout: true, allowed: true, out: "result.txt" },
  ],
  ["refusal-stderr-bad", { defaultRules: true, badStderr: true }],
  ["inactive", { inactive: true }],
  [
    "hexagon-first",
    { flags: ["--hexagon", "--json"], hex: true, preLayer: true },
  ],
  ["second-root-read", { removeMarker: true }],
  ["raw-root", { rawRoot: true, rawArgv: true, flags: ["--json"] }],
  ["raw-self-root", { rawRoot: true, rawArgv: true, selfMarker: true }],
  [
    "raw-self-alias",
    { rawRoot: true, rawArgv: true, selfMarker: true, alias: true },
  ],
  ["unicode-self-alias", { unicodeRoot: true, selfMarker: true, alias: true }],
  ["raw-relative-specifier", { rawImport: true, flags: ["--json"] }],
  [
    "raw-relative-root-collision",
    {
      rawRoot: true,
      rawArgv: true,
      selfMarker: true,
      rawRelativeRoot: true,
      flags: ["--json"],
    },
  ],
  [
    "unreachable-accept-prepared-unused",
    { flags: ["--unreachable", "--accept-dead", "--reason=why"] },
  ],
  ["unreachable-ci-prepared-unused", { flags: ["--unreachable", "--ci"] }],
  ["api-first", { flags: ["--api=missing-api.json"], preLayer: true }],
];
export function layerFixture(directory, opts) {
  const root = path.join(directory, "repo");
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(root, { recursive: true });
  const appRelative = opts.rawRoot
    ? "packages/raw\ud800"
    : opts.unicodeRoot
      ? "packages/😀"
      : "packages/app";
  const app = path.join(root, appRelative);
  fs.mkdirSync(app, { recursive: true });
  write(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  for (const [file, text] of Object.entries(files))
    write(path.join(app, file), text);
  if (opts.selfMarker)
    write(path.join(app, "pnpm-workspace.yaml"), "packages: []\n");
  if (opts.alias) {
    write(
      path.join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@local/*": ["src/*"] } },
      }),
    );
    write(
      path.join(app, "src/service/use-case.ts"),
      files["src/service/use-case.ts"].replace(
        "../domain/entity.js",
        "@local/domain/entity.js",
      ),
    );
  }
  if (opts.rawImport) {
    write(
      path.join(app, "src/ui/extra\ud800.ts"),
      "export type Extra=string;\n",
    );
    write(
      path.join(app, "src/domain/store.ts"),
      files["src/domain/store.ts"] +
        'import type {Extra} from "../ui/extra\\ud800.js";\n',
    );
  }
  if (opts.rawRelativeRoot) {
    write(
      path.join(app, "src/service/use-case.ts"),
      files["src/service/use-case.ts"].replace(
        "../domain/entity.js",
        "../../../raw�/src/domain/entity.js",
      ),
    );
  }
  const layerPrefix = opts.selfMarker ? "" : appRelative + "/";

  const layers = [
    { name: opts.unicode ? "UI🍵" : "ui", paths: [`${layerPrefix}src/ui`] },
    {
      name: opts.unicode ? "serviceé" : "service",
      paths: [`${layerPrefix}src/service`],
    },
    { name: "domain", paths: [`${layerPrefix}src/domain`] },
  ];
  const allowed = opts.allowed
    ? [
        {
          from: `${layerPrefix}src/service/use-case.ts`,
          to: `${layerPrefix}src/ui/view-model.ts`,
          sites: opts.miscount ? 2 : 1,
          reason: "Pass the contract in.",
        },
        {
          from: `${layerPrefix}src/domain/store.ts`,
          to: `${layerPrefix}src/service/use-case.ts`,
          sites: 1,
          reason: "Temporary bridge 🍵.",
        },
      ]
    : [];
  if (opts.stale)
    allowed.push({
      from: `${layerPrefix}src/domain/entity.ts`,
      to: `${layerPrefix}src/ui/view-model.ts`,
      sites: 1,
      reason: "stale",
    });
  const rules = path.join(root, "rules.json");
  write(
    rules,
    opts.rules === "malformed"
      ? "{broken"
      : JSON.stringify({ layers, allowed }),
  );
  if (opts.tie) {
    write(path.join(app, "billing-plumbing.ts"), "export const billing=1;\n");
    write(
      rules,
      JSON.stringify({
        layers: [
          { name: "plumbing", paths: ["**/*-plumbing.ts"] },
          { name: "billing", paths: ["**/billing-p*.ts"] },
        ],
      }),
    );
  }
  if (opts.badTsconfig) write(path.join(app, "tsconfig.json"), "{broken");
  if (opts.badSmell) write(path.join(root, "smell-ledger.json"), "{broken");
  if (opts.badUnreachable)
    write(path.join(root, "unreachable-ledger.json"), "{broken");
  if (opts.badGlobal) write(path.join(root, "bad.json"), "{broken");
  if (opts.hex)
    write(
      path.join(app, "ports.ts"),
      "export interface Port { run(): void; }\n",
    );
  const argv = [
    appRelative,
    ...(opts.inactive ? ["--graph"] : ["--layers"]),
    ...(!opts.defaultRules
      ? [
          "--layer-rules",
          opts.rules === "missing" ? "missing-rules.json" : "rules.json",
        ]
      : []),
    ...(opts.flags ?? []),
    ...(opts.out === undefined ? [] : ["--out", opts.out]),
  ];
  return { root, app, argv, rules };
}
