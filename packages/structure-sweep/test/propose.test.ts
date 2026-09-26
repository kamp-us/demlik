import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { proposeCommand } from "../src/propose/cli.js";
import { DEFAULT_ROLES, renderProposePrompt } from "../src/propose/prompt.js";
import { gatherSignals, type ProposeSignals } from "../src/propose/signals.js";
import type { FileEvidence } from "../src/sweep/evidence.js";
import { readGraphFile } from "../src/sweep/graph.js";
import type { SweepQuestions } from "../src/sweep/questions.js";
import { runSweep } from "../src/sweep/run.js";
import { parseVocabulary } from "../src/vocabulary.js";
import { choice, repo, stubJev, write } from "./helpers.js";

const fixture = () =>
  repo({
    "package.json": JSON.stringify({ name: "shop", private: true }),
    "apps/web/package.json": JSON.stringify({ name: "@shop/web" }),
    "apps/web/src/index.ts": "export {};",
    "apps/web/src/catalog/search.ts": "export const search = 1;",
    "apps/web/src/catalog/search.test.ts": "it('is not swept', () => {});",
    "apps/web/src/catalog/ui/list/deep/row.tsx": "export const Row = 1;",
    "apps/web/src/ödeme/fatura.ts": "export const fatura = 1;",
    "apps/web/src/assets/logo.svg": "<svg/>",
    "paketler/ödeme/package.json": JSON.stringify({ name: "@shop/ödeme" }),
    "tools/package.json": "{ not json",
  });

const signalsOf = (
  root: string,
  graphs: string[] = [],
  scopes = ["apps/web/src"],
) =>
  gatherSignals({
    root,
    ref: "HEAD",
    scopes,
    depth: 3,
    graphs: graphs.map((g) => ({
      file: relative(root, g),
      graph: readGraphFile(g),
    })),
  });

function graphFile(
  dir: string,
  body: Record<string, unknown>,
  name = Object.keys(body).join("-"),
): string {
  const path = join(dir, `${name}.graph.json`);
  writeFileSync(
    path,
    JSON.stringify({
      root: "apps/web",
      functions: [],
      crossRuntime: null,
      ...body,
    }),
  );
  return path;
}

const promptFor = (signals: ProposeSignals) =>
  renderProposePrompt({
    signals,
    features: 8,
    roles: DEFAULT_ROLES,
    draft: ".structure-sweep/proposed.config.json",
    graphs: [],
  });

/** The one fenced JSON block under the markdown heading `## <heading>`. */
function jsonUnder(markdown: string, heading: string): unknown {
  const section = markdown.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
  const block = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (block === undefined) throw new Error(`no json block under ## ${heading}`);
  return JSON.parse(block);
}

describe("gatherSignals", () => {
  it("lists folders to a bounded depth, packages by name, and reads non-ASCII paths unquoted", () => {
    const root = fixture();
    write(root, { "apps/web/src/scratch/untracked.ts": "export {};" });

    const signals = signalsOf(root);

    expect(signals.directories).toEqual([
      { path: "apps/web/src/catalog", files: 2 },
      { path: "apps/web/src/catalog/ui", files: 1 },
      { path: "apps/web/src/catalog/ui/list", files: 1 },
      { path: "apps/web/src/ödeme", files: 1 },
    ]);
    expect(signals.packages).toEqual([
      { path: "", name: "shop" },
      { path: "apps/web", name: "@shop/web" },
      { path: "paketler/ödeme", name: "@shop/ödeme" },
    ]);
    expect(signals.graph).toBeNull();
  });

  it("gives byte-identical signals on two runs over one checkout", () => {
    const root = fixture();
    expect(JSON.stringify(signalsOf(root))).toBe(
      JSON.stringify(signalsOf(root)),
    );
  });

  it("reads cluster names and cross-runtime methods from a code-graph file", () => {
    const root = fixture();
    const clustered = graphFile(root, {
      crossRuntime: {
        edges: [
          {
            callerId: "src/a.ts:f",
            targetService: "billing",
            method: "charge",
          },
          {
            callerId: "src/b.ts:g",
            targetService: "billing",
            method: "charge",
          },
          { callerId: "src/b.ts:g", targetService: "auth", method: "verify" },
        ],
      },
      clusters: {
        scatteredClusters: [
          { id: "c01", dirs: [{ dir: "src/catalog" }, { dir: "src/ödeme" }] },
        ],
      },
    });

    expect(signalsOf(root, [clustered]).graph).toEqual({
      clusters: [
        {
          graph: "crossRuntime-clusters.graph.json",
          id: "c01",
          dirs: ["apps/web/src/catalog", "apps/web/src/ödeme"],
        },
      ],
      crossRuntime: ["auth.verify", "billing.charge"],
    });
    expect(
      signalsOf(root, [graphFile(root, { clusters: null })]).graph,
    ).toEqual({ clusters: null, crossRuntime: [] });
  });

  it("keeps two graphs' same-numbered clusters apart by naming the graph each came from", () => {
    const root = fixture();
    const clusterIn = (name: string, dir: string) =>
      graphFile(
        root,
        {
          clusters: {
            scatteredClusters: [
              { id: "c01", dirs: [{ dir: "src/catalog" }, { dir }] },
            ],
          },
        },
        name,
      );

    const clusters = signalsOf(root, [
      clusterIn("web", "src/ödeme"),
      clusterIn("admin", "src/assets"),
    ]).graph?.clusters;

    expect(clusters?.map((c) => [c.graph, c.id])).toEqual([
      ["web.graph.json", "c01"],
      ["admin.graph.json", "c01"],
    ]);
    expect(
      promptFor(signalsOf(root, [clusterIn("web", "src/ödeme")])),
    ).toContain(
      "- c01 in `web.graph.json`: `apps/web/src/catalog`, `apps/web/src/ödeme`",
    );
  });

  it("counts a file once when two scopes overlap", () => {
    const root = fixture();

    const { directories } = signalsOf(root, [], ["apps/web", "apps/web/src"]);

    expect(directories).toContainEqual({
      path: "apps/web/src/catalog",
      files: 2,
    });
    expect(directories).toContainEqual({
      path: "apps/web/src/catalog/ui",
      files: 1,
    });
  });
});

describe("renderProposePrompt", () => {
  it("renders the same prompt for the same signals", () => {
    const root = fixture();
    expect(promptFor(signalsOf(root))).toBe(promptFor(signalsOf(root)));
  });

  it("carries the signals, the count, the roles, the schema and where to write the config", () => {
    const prompt = promptFor(signalsOf(fixture()));

    expect(prompt).toContain("Draft 8 features");
    expect(prompt).toContain("`apps/web/src/ödeme` (1)");
    expect(prompt).toContain("`@shop/web` in `apps/web`");
    expect(prompt).toContain(
      "not read: no code-graph `--graph` file was passed",
    );
    expect(jsonUnder(prompt, "Roles")).toEqual(DEFAULT_ROLES);
    expect(Object.keys(jsonUnder(prompt, "Roles") as object)).toEqual([
      "business_rule",
      "api_surface",
      "flows",
      "persistence",
      "plumbing",
    ]);
    expect(jsonUnder(prompt, "Schema")).toMatchObject({
      required: ["features", "roles"],
      additionalProperties: false,
    });
    expect(prompt).toContain(
      "Write the config as JSON to `.structure-sweep/proposed.config.json`",
    );
    expect(prompt).toContain(
      "structure-sweep sweep apps/web/src --config .structure-sweep/proposed.config.json",
    );
    expect(prompt).toContain("structure-sweep score");
  });

  it("holds an example config that parseVocabulary accepts", () => {
    const example = jsonUnder(promptFor(signalsOf(fixture())), "Example");
    expect(() => parseVocabulary(example)).not.toThrow();
  });

  it("names no specific coding agent", () => {
    expect(promptFor(signalsOf(fixture()))).not.toMatch(
      /claude|codex|cursor|copilot|gpt|anthropic|openai/i,
    );
  });
});

describe("proposeCommand", () => {
  const read = (root: string) => [
    readFileSync(join(root, ".structure-sweep/signals.json"), "utf8"),
    readFileSync(join(root, ".structure-sweep/propose-prompt.md"), "utf8"),
  ];

  it("writes both files, refuses to overwrite them, and rewrites the same bytes under --force", () => {
    const root = realpathSync(fixture());
    proposeCommand(["apps/web/src"], root);
    const first = read(root);

    expect(() => proposeCommand(["apps/web/src"], root)).toThrow(
      /already exist; pass --force/,
    );
    proposeCommand(["apps/web/src", "--force"], root);
    expect(read(root)).toEqual(first);
  });

  it("takes the roles and product line from --config", () => {
    const root = realpathSync(fixture());
    const vocabulary = {
      product: "a shop",
      features: { a: "A things.", b: "B things." },
      roles: {
        rule: { description: "Decides.", dir: "rules" },
        glue: { description: "Plumbing.", dir: "lib", shared: true },
      },
    };
    write(root, { "vocab.json": JSON.stringify(vocabulary) });

    proposeCommand(["apps/web/src", "--config", "vocab.json"], root);
    const [, prompt] = read(root);

    expect(jsonUnder(prompt ?? "", "Roles")).toEqual({
      rule: { description: "Decides.", dir: "rules", shared: false },
      glue: { description: "Plumbing.", dir: "lib", shared: true },
    });
    expect(prompt).toContain('"product": "a shop"');
  });
});

describe("a config drafted from the prompt", () => {
  it("runs through the existing sweep and gets rows of the unchanged shape", async () => {
    const root = fixture();
    const drafted = parseVocabulary({
      product: "a shop",
      features: {
        catalog: "Products and search over them.",
        payments: "Invoices and taking payment.",
      },
      roles: jsonUnder(promptFor(signalsOf(root)), "Roles"),
    });
    const features = Object.keys(drafted.features);
    const roles = Object.keys(drafted.roles);
    const jev = stubJev<SweepQuestions>((state: JevState) => ({
      feature: choice(
        (state as FileEvidence).file.path.includes("catalog")
          ? "catalog"
          : "payments",
        features,
      ),
      role: choice("business_rule", roles),
      rule_inside_surface: { type: "noul", noul: 0.1 },
    }));

    const result = await runSweep({
      root,
      ref: "HEAD",
      scopes: ["apps/web/src/catalog"],
      vocabulary: drafted,
      jev,
      verdictsPath: join(
        mkdtempSync(join(tmpdir(), "verdicts-")),
        "verdicts.json",
      ),
    });

    expect(result.rows.map((r) => r.path)).toEqual([
      "apps/web/src/catalog/search.ts",
      "apps/web/src/catalog/ui/list/deep/row.tsx",
    ]);
    for (const row of result.rows)
      expect(Object.keys(row).sort()).toEqual([
        "answers",
        "hash",
        "model",
        "path",
        "scope",
        "usage",
        "vocabulary",
      ]);
  });
});
