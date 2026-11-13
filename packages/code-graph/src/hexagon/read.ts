import fs from "node:fs";
import path from "node:path";
import { parseTypeScript } from "../engine/oxc.js";
import { listSourceFiles, toRelative } from "../extract/project.js";
import { SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import {
  type HexagonBag,
  type HexagonPort,
  lexical,
  type NotRead,
  type PortList,
  readPorts,
} from "./ports.js";

export type Hexagon = {
  feature: string | null;
  commands: PortList;
  externalSystems: PortList;
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

// The names `X` for which `ports.ts` holds both a bag `X` and a bag `XDriven`: what a feature looks
// like in its ports, whether or not a function builds it.
function pairedFeatures(bags: HexagonBag[]): string[] {
  const names = new Set(bags.map((bag) => bag.name));
  return [...names].filter((name) => names.has(`${name}Driven`)).sort(lexical);
}

function findFactory(root: string, useCases: Hexagon["useCases"], paired: string[]) {
  const factories = useCases.flatMap(({ file, functions }) =>
    functions.filter((name) => /^create[A-Z]/.test(name)).map((name) => ({ file, name })),
  );
  const score = (factory: { file: string; name: string }): number => {
    if (factory.file === `application/${path.basename(root)}.ts`) return 0;
    return paired.includes(factory.name.slice(6)) ? 1 : 2;
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

// A feature is named by its factory. With none, the one pair of bags `ports.ts` holds names it, and
// two pairs leave it unnamed, because nothing here chooses between them.
function featureOf(factory: { name: string } | null, paired: string[]): string | null {
  if (factory !== null) return factory.name.slice(6);
  return paired.length === 1 ? (paired[0] ?? null) : null;
}

function listOf(bags: HexagonBag[], notRead: NotRead[], name: string | null): PortList {
  const bag = bags.find((candidate) => candidate.name === name);
  if (bag !== undefined) return bag.members;
  const row = notRead.find((candidate) => candidate.file === "ports.ts" && candidate.name === name);
  return row === undefined ? [] : { notRead: row };
}

function byPlace(a: NotRead, b: NotRead): number {
  return (
    lexical(a.file, b.file) ||
    a.line - b.line ||
    lexical(a.name, b.name) ||
    lexical(a.reason, b.reason)
  );
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
  const paired = pairedFeatures(ports.bags);
  const feature = featureOf(findFactory(root, useCases, paired), paired);
  notRead.sort(byPlace);
  return {
    feature,
    commands: listOf(ports.bags, notRead, feature),
    externalSystems: listOf(ports.bags, notRead, feature === null ? null : `${feature}Driven`),
    otherBags: ports.bags.filter(
      (bag) => feature === null || (bag.name !== feature && bag.name !== `${feature}Driven`),
    ),
    unbaggedPorts: ports.unbaggedPorts,
    useCases,
    adapters: {
      driving: files.filter((file) => file.startsWith("adapters/driving/")),
      driven: files.filter((file) => file.startsWith("adapters/driven/")),
    },
    notRead,
  };
}
