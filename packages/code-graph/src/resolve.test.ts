import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as ts from "./engine/tsgo.js";
import { type InProcessGraph, loadInProcessGraph } from "./resolve.js";

vi.mock("./engine/tsgo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/tsgo.js")>();
  return { ...actual, openTypeSession: vi.fn(actual.openTypeSession) };
});

let root = "";
const opened: InProcessGraph[] = [];

function load(): InProcessGraph | null {
  const graph = loadInProcessGraph(root);
  if (graph !== null) opened.push(graph);
  return graph;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-resolve-")));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    "origin.ts": "export function realName(): number {\n  return 1;\n}\nexport default () => 2;\n",
    "barrel.ts":
      'export { realName as renamed } from "./origin";\nexport { default } from "./origin";\n',
    "consumer.ts": 'import { renamed } from "./barrel";\nexport const value = renamed();\n',
    "direct.ts": 'import { realName } from "./origin";\nexport const direct = realName();\n',
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
});

beforeEach(() => {
  vi.mocked(ts.openTypeSession).mockClear();
});

afterAll(() => {
  for (const graph of opened) graph.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadInProcessGraph", () => {
  it("follows a re-export through a barrel to the declaring file and its own name", () => {
    const origin = load()?.resolveExportOrigin(
      path.join(root, "consumer.ts"),
      "./barrel",
      "renamed",
    );
    expect(origin).toEqual({ file: path.join(root, "origin.ts"), name: "realName" });
  });

  it("keeps the export name for an anonymous default", () => {
    const origin = load()?.resolveExportOrigin(
      path.join(root, "consumer.ts"),
      "./barrel",
      "default",
    );
    expect(origin).toEqual({ file: path.join(root, "origin.ts"), name: "default" });
  });

  it("answers null for a specifier the file does not import or a name the module lacks", () => {
    const graph = load();
    const consumer = path.join(root, "consumer.ts");
    expect(graph?.resolveExportOrigin(consumer, "./missing", "renamed")).toBeNull();
    expect(graph?.resolveExportOrigin(consumer, "./barrel", "absent")).toBeNull();
  });

  it("answers null when no tsconfig sits at or above the root", () => {
    expect(
      loadInProcessGraph(path.parse(root).root, { repoRoot: path.parse(root).root }),
    ).toBeNull();
  });
});

describe("one tsgo session per graph (#444)", () => {
  const lookups: readonly (readonly [string, string, string])[] = [
    ["consumer.ts", "./barrel", "renamed"],
    ["consumer.ts", "./barrel", "default"],
    ["direct.ts", "./origin", "realName"],
    ["consumer.ts", "./barrel", "absent"],
    ["direct.ts", "./barrel", "renamed"],
  ];
  const resolve = (
    graph: InProcessGraph | null,
    [file, specifier, name]: (typeof lookups)[number],
  ) => graph?.resolveExportOrigin(path.join(root, file), specifier, name);

  it("opens no session until the first lookup and exactly one across several", () => {
    const graph = load();
    expect(ts.openTypeSession).toHaveBeenCalledTimes(0);
    const shared = lookups.map((lookup) => resolve(graph, lookup));
    expect(ts.openTypeSession).toHaveBeenCalledTimes(1);

    const perCall = lookups.map((lookup) => {
      const fresh = load();
      const answer = resolve(fresh, lookup);
      fresh?.dispose();
      return answer;
    });
    expect(shared).toEqual(perCall);
    expect(shared).toEqual([
      { file: path.join(root, "origin.ts"), name: "realName" },
      { file: path.join(root, "origin.ts"), name: "default" },
      { file: path.join(root, "origin.ts"), name: "realName" },
      null,
      null,
    ]);
  });

  it("closes the session on dispose and refuses a lookup after it", () => {
    const graph = load();
    expect(resolve(graph, lookups[0] ?? ["", "", ""])).not.toBeNull();
    const [session] = vi.mocked(ts.openTypeSession).mock.results;
    const close = vi.spyOn(session?.value as ts.TypeSession, "close");
    graph?.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => resolve(graph, lookups[0] ?? ["", "", ""])).toThrow(/disposed/);
    graph?.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens nothing when disposed before any lookup", () => {
    load()?.dispose();
    expect(ts.openTypeSession).toHaveBeenCalledTimes(0);
  });
});
