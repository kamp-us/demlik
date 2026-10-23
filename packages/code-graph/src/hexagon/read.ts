import fs from "node:fs";
import path from "node:path";
import { parseTypeScript } from "../engine/oxc.js";
import { listSourceFiles, toRelative } from "../extract/project.js";
import { SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import {
  type HexagonBag,
  type HexagonMember,
  type HexagonPort,
  lexical,
  type NotRead,
  readPorts,
} from "./ports.js";

export type Hexagon = {
  feature: string | null;
  commands: HexagonMember[];
  externalSystems: HexagonMember[];
  otherBags: HexagonBag[];
  unbaggedPorts: HexagonPort[];
  useCases: { file: string; functions: string[] }[];
  adapters: { driving: string[]; driven: string[] };
  notRead: NotRead[];
};

function readSyntax(root: string, file: string, notRead: NotRead[]): SyntaxFile | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    notRead.push({ file, line: 1, name: "<source>", reason: "cannot read source" });
    return null;
  }
  const parsed = parseTypeScript(file, text);
  if (parsed.ok) return new SyntaxFile(text, parsed.program, parsed.comments);
  notRead.push({ file, line: 1, name: "<source>", reason: "cannot parse source" });
  return null;
}

function functionNames(node: SyntaxNode | null): string[] {
  if (node?.type === "FunctionDeclaration" && node.id !== null && node.body !== null)
    return [node.id.name];
  if (node?.type !== "VariableDeclaration" || node.kind !== "const") return [];
  return node.declarations.flatMap(({ id, init }) =>
    id.type === "Identifier" &&
    ["ArrowFunctionExpression", "FunctionExpression"].includes(init?.type ?? "")
      ? [id.name]
      : [],
  );
}

function exportedFunctions(syntax: SyntaxFile | null): string[] {
  const names =
    syntax?.program.body.flatMap((statement) =>
      statement.type === "ExportNamedDeclaration" ? functionNames(statement.declaration) : [],
    ) ?? [];
  return [...new Set(names)].sort(lexical);
}

function findFactory(root: string, useCases: Hexagon["useCases"], bags: HexagonBag[]) {
  const names = new Set(bags.map((bag) => bag.name));
  const factories = useCases.flatMap(({ file, functions }) =>
    functions.filter((name) => /^create[A-Z]/.test(name)).map((name) => ({ file, name })),
  );
  const score = (factory: { file: string; name: string }): number => {
    if (factory.file === `application/${path.basename(root)}.ts`) return 0;
    const feature = factory.name.slice(6);
    return names.has(feature) && names.has(`${feature}Driven`) ? 1 : 2;
  };
  return (
    factories.sort(
      (a, b) => score(a) - score(b) || lexical(a.file, b.file) || lexical(a.name, b.name),
    )[0] ?? null
  );
}

function checkDirectory(directory: string, recursive = false): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`cannot read directory: ${directory}`);
  }
  if (recursive)
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !["node_modules", "vendor", "dist", "__generated__"].includes(entry.name)
      )
        checkDirectory(path.join(directory, entry.name), true);
    }
}

function checkLayout(root: string): void {
  checkDirectory(root);
  const portsPath = path.join(root, "ports.ts");
  if (!fs.existsSync(portsPath)) throw new Error(`missing ports.ts: ${portsPath}`);
  for (const directory of ["application", "adapters"]) {
    if (fs.existsSync(path.join(root, directory)))
      checkDirectory(path.join(root, directory), directory === "adapters");
  }
}

function membersOf(bags: HexagonBag[], name: string | null): HexagonMember[] {
  return bags.find((bag) => bag.name === name)?.members ?? [];
}

export function readHexagon(root: string): Hexagon {
  checkLayout(root);
  const notRead: NotRead[] = [];
  const syntax = readSyntax(root, "ports.ts", notRead);
  const ports = readPorts(syntax, notRead);
  const files = listSourceFiles(root)
    .map((file) => toRelative(root, file))
    .sort(lexical);
  const useCases = files
    .filter((file) => /^application\/[^/]+\.ts$/.test(file))
    .map((file) => ({ file, functions: exportedFunctions(readSyntax(root, file, notRead)) }));
  const factory = findFactory(root, useCases, ports.bags);
  const feature = factory?.name.slice(6) ?? null;
  return {
    feature,
    commands: membersOf(ports.bags, feature),
    externalSystems: membersOf(ports.bags, feature === null ? null : `${feature}Driven`),
    otherBags: ports.bags.filter(
      (bag) => feature === null || (bag.name !== feature && bag.name !== `${feature}Driven`),
    ),
    unbaggedPorts: ports.unbaggedPorts,
    useCases,
    adapters: {
      driving: files.filter((file) => file.startsWith("adapters/driving/")),
      driven: files.filter((file) => file.startsWith("adapters/driven/")),
    },
    notRead: notRead.sort(
      (a, b) =>
        lexical(a.file, b.file) ||
        a.line - b.line ||
        lexical(a.name, b.name) ||
        lexical(a.reason, b.reason),
    ),
  };
}
