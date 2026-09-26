import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadInProcessGraph } from "./resolve.js";

let root = "";

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-resolve-")));
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
    "origin.ts": "export function realName(): number {\n  return 1;\n}\nexport default () => 2;\n",
    "barrel.ts":
      'export { realName as renamed } from "./origin";\nexport { default } from "./origin";\n',
    "consumer.ts": 'import { renamed } from "./barrel";\nexport const value = renamed();\n',
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadInProcessGraph", () => {
  it("follows a re-export through a barrel to the declaring file and its own name", () => {
    const graph = loadInProcessGraph(root);
    const origin = graph?.resolveExportOrigin(
      path.join(root, "consumer.ts"),
      "./barrel",
      "renamed",
    );
    expect(origin).toEqual({ file: path.join(root, "origin.ts"), name: "realName" });
  });

  it("keeps the export name for an anonymous default", () => {
    const graph = loadInProcessGraph(root);
    const origin = graph?.resolveExportOrigin(
      path.join(root, "consumer.ts"),
      "./barrel",
      "default",
    );
    expect(origin).toEqual({ file: path.join(root, "origin.ts"), name: "default" });
  });

  it("answers null for a specifier the file does not import or a name the module lacks", () => {
    const graph = loadInProcessGraph(root);
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
