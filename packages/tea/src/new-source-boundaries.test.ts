import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const effectPackage = "effect";

function violations(file: string, source: string): string[] {
  const out: string[] = [];
  const effectHome = /\/src\/(?:effect|testing\/effect)\//.test(file);
  const edge = /\/src\/(?:node|do|extension)\//.test(file);
  const specifier = (name: string) => {
    if (name === "@demlik/tea" || name.startsWith("@demlik/tea/"))
      out.push("self import");
    if (!effectHome && /^(?:effect(?:\/|$)|@effect\/)/.test(name))
      out.push("Effect outside its engine");
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      specifier(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      specifier(node.arguments[0].text);
    if (
      !edge &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    )
      out.push("environment below edge");
    if (
      !edge &&
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "env"
    )
      out.push("environment below edge");
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return out;
}

describe("new tea source obeys the import and environment boundaries", () => {
  it.each([
    [
      "internal/example.ts",
      `import { Effect } from "${effectPackage}";`,
      ["Effect outside its engine"],
    ],
    [
      "internal/example.ts",
      'import { run } from "@demlik/tea/promise";',
      ["self import"],
    ],
    [
      "internal/example.ts",
      "const key = process.env.KEY;",
      ["environment below edge"],
    ],
    [
      "internal/example.ts",
      'const key = process["env"].KEY;',
      ["environment below edge"],
    ],
    ["effect/example.ts", `import { Effect } from "${effectPackage}";`, []],
    [
      "testing/effect/example.ts",
      `const pkg = import("${effectPackage}");`,
      [],
    ],
    ["node/example.ts", "const key = process.env.KEY;", []],
  ] as const)("checks %s: %s", (file, source, expected) => {
    expect(violations(`packages/tea/src/${file}`, source)).toEqual(expected);
  });

  it("checks every added source file, including untracked work", () => {
    const paths = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" })
        .split("\0")
        .filter(Boolean);
    const files = new Set([
      ...paths([
        "diff",
        "--name-only",
        "--diff-filter=A",
        "-z",
        "origin/main",
        "--",
        "packages/tea/src",
      ]),
      ...paths([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "packages/tea/src",
      ]),
    ]);
    const found = [...files]
      .filter((file) => /\.tsx?$/.test(file))
      .flatMap((file) =>
        violations(file, readFileSync(resolve(root, file), "utf8")).map(
          (rule) => ({ file, rule }),
        ),
      );
    expect(found).toEqual([]);
  });
});
