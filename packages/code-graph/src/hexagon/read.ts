import fs from "node:fs";
import path from "node:path";
import { parseTypeScript } from "../engine/oxc.js";
import { discoverFunctions, exportedLocalNames } from "../extract/functions.js";
import { listSourceFiles, type SourceUnit, toRelative } from "../extract/project.js";
import { SyntaxFile } from "../syntax/file.js";
import {
  type HexagonBag,
  type HexagonMember,
  type HexagonPort,
  lexical,
  readPorts,
} from "./ports.js";

export type Hexagon = {
  feature: string;
  commands: HexagonMember[];
  externalSystems: HexagonMember[];
  otherBags: HexagonBag[];
  unbaggedPorts: HexagonPort[];
  useCases: { file: string; functions: string[] }[];
  adapters: { driving: string[]; driven: string[] };
};

function readUnit(root: string, file: string): SourceUnit {
  const absolutePath = path.join(root, file);
  let text: string;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new Error(`cannot read ${absolutePath}`);
  }
  const parsed = parseTypeScript(absolutePath, text);
  if (!parsed.ok) throw new Error(`cannot parse ${absolutePath}`);
  return { file, absolutePath, syntax: new SyntaxFile(text, parsed.program, parsed.comments) };
}

function exportedFunctions(unit: SourceUnit): string[] {
  const exported = exportedLocalNames(unit.syntax);
  const { functions } = discoverFunctions([unit]);
  return [
    ...new Set(
      functions
        .filter((fn) => {
          const parent = unit.syntax.parentOf(fn.node);
          const statement =
            parent?.type === "VariableDeclarator" ? unit.syntax.parentOf(parent) : null;
          const topLevelVariable =
            statement?.type === "VariableDeclaration" &&
            unit.syntax.parentOf(statement)?.type === "Program";
          return fn.isExported || (topLevelVariable && exported.has(fn.name));
        })
        .map((fn) => fn.name),
    ),
  ].sort(lexical);
}

function featureName(root: string, units: SourceUnit[], bags: HexagonBag[]): string {
  const main = `application/${path.basename(root)}.ts`;
  const names = new Set(bags.map((bag) => bag.name));
  const factories = units.flatMap((unit) =>
    exportedFunctions(unit)
      .filter((name) => /^create[A-Z]/.test(name))
      .map((name) => ({ file: unit.file, name: name.slice(6) })),
  );
  const score = (factory: { file: string; name: string }): number =>
    factory.file === main
      ? 0
      : names.has(factory.name) && names.has(`${factory.name}Driven`)
        ? 1
        : 2;
  factories.sort(
    (a, b) => score(a) - score(b) || lexical(a.file, b.file) || lexical(a.name, b.name),
  );
  return (
    factories[0]?.name ??
    path
      .basename(root)
      .split(/[^a-zA-Z0-9]+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")
  );
}

export function readHexagon(root: string): Hexagon {
  const portsPath = path.join(root, "ports.ts");
  if (!fs.existsSync(portsPath)) throw new Error(`missing ports.ts: ${portsPath}`);
  const { bags, unbaggedPorts } = readPorts(readUnit(root, "ports.ts").syntax, portsPath);
  const files = listSourceFiles(root)
    .map((file) => toRelative(root, file))
    .sort(lexical);
  const application = files.filter((file) => /^application\/[^/]+\.ts$/.test(file));
  const units = application.map((file) => readUnit(root, file));
  const feature = featureName(root, units, bags);
  const adapters = { driving: [] as string[], driven: [] as string[] };
  for (const direction of ["driving", "driven"] as const) {
    adapters[direction] = files.filter((file) => file.startsWith(`adapters/${direction}/`));
    for (const file of adapters[direction]) readUnit(root, file);
  }
  return {
    feature,
    commands: bags.find((bag) => bag.name === feature)?.members ?? [],
    externalSystems: bags.find((bag) => bag.name === `${feature}Driven`)?.members ?? [],
    otherBags: bags.filter((bag) => bag.name !== feature && bag.name !== `${feature}Driven`),
    unbaggedPorts,
    useCases: units.map((unit) => ({ file: unit.file, functions: exportedFunctions(unit) })),
    adapters,
  };
}
