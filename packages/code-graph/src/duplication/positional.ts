import { field, nodeField, type SyntaxNode } from "../syntax/file.js";
import type { Site } from "./scan.js";
import type { DuplicationSettings } from "./settings.js";
import { argumentsOf, referenceName, unwrap } from "./values.js";

type Slot = number | string;
export type CallShape = { key: string; references: { slot: Slot; name: string }[] };
export type PositionalClump = {
  kind: "positional";
  callee: string;
  slots: Slot[];
  distinctTupleCount: number;
  siteCount: number;
  sites: Site[];
};

function optionsKey(property: SyntaxNode): string | null {
  if (
    property.type !== "Property" ||
    field(property, "computed") === true ||
    field(property, "method") === true ||
    field(property, "kind") !== "init"
  )
    return null;
  const key = nodeField(property, "key");
  const name =
    key?.type === "Identifier" ? field(key, "name") : key === null ? null : field(key, "value");
  return typeof name === "string" || typeof name === "number" ? String(name) : null;
}

function optionsShape(argument: SyntaxNode, index: number) {
  const properties = field(argument, "properties");
  if (!Array.isArray(properties)) return null;
  const keys: string[] = [];
  const references: CallShape["references"] = [];
  for (const property of properties) {
    const key = optionsKey(property);
    if (key === null || keys.includes(key)) return null;
    keys.push(key);
    const value = nodeField(property, "value");
    const name = value === null ? null : referenceName(value);
    if (name !== null) references.push({ slot: `${index}.${key}`, name });
  }
  references.sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
  return { keys: keys.sort(), references };
}

export function callShape(call: SyntaxNode): CallShape | null {
  const references: CallShape["references"] = [];
  const objects: [number, string[]][] = [];
  const args = argumentsOf(call);
  for (const [index, wrapped] of args.entries()) {
    const argument = unwrap(wrapped);
    const name = referenceName(argument);
    if (name !== null) references.push({ slot: index, name });
    if (argument.type !== "ObjectExpression") continue;
    const options = optionsShape(argument, index);
    if (options === null) return null;
    objects.push([index, options.keys]);
    references.push(...options.references);
  }
  return { key: JSON.stringify([args.length, objects, references.map((r) => r.slot)]), references };
}

export function positionalClumps(
  callee: string,
  calls: readonly { site: Site; shape: CallShape | null }[],
  settings: DuplicationSettings,
): PositionalClump[] {
  const groups = new Map<string, { site: Site; shape: CallShape }[]>();
  for (const { site, shape } of calls) {
    if (shape === null) continue;
    const group = groups.get(shape.key) ?? [];
    group.push({ site, shape });
    groups.set(shape.key, group);
  }
  const result: PositionalClump[] = [];
  for (const group of groups.values()) {
    if (group.length < settings.clumpMinSites) continue;
    const first = group[0];
    if (first === undefined) continue;
    const varying = first.shape.references.flatMap((reference, index) =>
      group.some((call) => call.shape.references[index]?.name !== reference.name) ? [index] : [],
    );
    if (varying.length < settings.clumpMinValues) continue;
    result.push({
      kind: "positional",
      callee,
      slots: varying.map((index) => first.shape.references[index].slot),
      distinctTupleCount: new Set(
        group.map((call) =>
          JSON.stringify(varying.map((index) => call.shape.references[index].name)),
        ),
      ).size,
      siteCount: group.length,
      sites: group.map((call) => call.site),
    });
  }
  return result;
}
