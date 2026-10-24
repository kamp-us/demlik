import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { readPublishedApi } from "../../packages/code-graph/src/api/view.ts";
import { readApiMap } from "../../packages/tea/src/api-ratchet/api-map.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const exportTarget = z.union([
  z.string(),
  z.object({ import: z.string().optional() }),
]);
const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  exports: z.record(z.string(), exportTarget),
});
const configSchema = z.object({ entry: z.record(z.string(), z.string()) });
const warnings: string[] = [];
const capabilities: { id: string; kind: string; signature: string }[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

for (const directory of ["tea", "code-graph"]) {
  const packageRoot = path.join(root, "packages", directory);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")),
  );
  const config = configSchema.parse(
    (await import(pathToFileURL(path.join(packageRoot, "tsup.config.ts")).href))
      .default,
  );
  const map: Record<string, { entry: string; tier?: string }> =
    directory === "tea" ? await readApiMap(packageRoot) : {};
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath.includes("*")) continue;
    const built = typeof target === "string" ? target : target.import;
    if (!built?.endsWith(".js")) {
      capabilities.push({
        id: `${manifest.name}:${subpath}`,
        kind: "asset",
        signature: hash(JSON.stringify(target)),
      });
      continue;
    }
    if (directory === "code-graph") {
      const entry =
        config.entry[built.replace(/^\.\/dist\//, "").replace(/\.js$/, "")];
      if (!entry)
        throw new Error(`No source entry for ${manifest.name}:${subpath}`);
      map[subpath] = { entry };
    }
  }
  const api = await readPublishedApi(packageRoot, map, {
    repoRoot: root,
    warn: (message) => warnings.push(message),
  });
  for (const [subpath, exported] of Object.entries(api.subpaths)) {
    for (const [name, declaration] of Object.entries(exported.names)) {
      const owner = `${manifest.name}:${subpath}#${name}`;
      capabilities.push({
        id: owner,
        kind: "export",
        signature: hash(JSON.stringify(declaration)),
      });
      for (const [origin, text] of Object.entries({
        published: declaration.text,
        ...declaration.references,
      })) {
        const source = ts.createSourceFile(
          "contract.d.ts",
          text,
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node): void {
          if (
            ts.isMethodSignature(node) ||
            ts.isCallSignatureDeclaration(node) ||
            ts.isConstructSignatureDeclaration(node) ||
            ts.isFunctionTypeNode(node)
          ) {
            const signature = hash(node.getText(source));
            const id = `${owner}/member:${origin}:${signature}`;
            if (!capabilities.some((capability) => capability.id === id))
              capabilities.push({ id, kind: "callable-member", signature });
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  if (directory === "code-graph" && manifest.exports["./dist/*"]) {
    for (const file of (await readdir(path.join(packageRoot, "dist"))).sort()) {
      if (!file.endsWith(".js") || file === "index.js") continue;
      const module = await import(
        pathToFileURL(path.join(packageRoot, "dist", file)).href
      );
      for (const name of Object.keys(module)) {
        capabilities.push({
          id: `${manifest.name}:./dist/${file}#${name}`,
          kind: "wildcard-export",
          signature: hash(name),
        });
      }
    }
  }
}

const cliText = await readFile(
  path.join(root, "packages/code-graph/src/cli.ts"),
  "utf8",
);
const cli = ts.createSourceFile(
  "cli.ts",
  cliText,
  ts.ScriptTarget.Latest,
  true,
);
function visitCli(node: ts.Node): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    const method = node.expression.name.text;
    const first = node.arguments[0];
    if (
      ["option", "requiredOption", "argument"].includes(method) &&
      first &&
      ts.isStringLiteral(first)
    ) {
      capabilities.push({
        id: `@demlik/code-graph:cli:${method}:${first.text}`,
        kind: "cli",
        signature: hash(node.getText(cli)),
      });
    }
  }
  ts.forEachChild(node, visitCli);
}
visitCli(cli);
const output = {
  version: 1,
  packages: ["@demlik/tea", "@demlik/code-graph"],
  capabilities,
  warnings,
};
await writeFile(process.argv[2], `${JSON.stringify(output, null, 2)}\n`);
