import type { HexagonMember } from "../hexagon/ports.js";
import { stableStringify } from "../render/json.js";
import type { FeatureReach, OwnedFeature } from "./features.js";
import { locusText } from "./locus.js";
import type { ScopeOwners } from "./scope.js";
import type { TechnologyRow } from "./technologies.js";
import type { BindingRow, WorkerRow } from "./workers.js";

// A file the view could not read, and why: today a wrangler config that does not parse, whose
// worker's bindings are then missing from the view.
export type NotRead = { readonly file: string; readonly reason: string };

export type OwnersReport = {
  readonly scopes: readonly ScopeOwners[];
  readonly notRead: readonly NotRead[];
};

const indent = (depth: number): string => "  ".repeat(depth);

// A title at `depth` and its lines one level in, `none` under a title with no lines. A line carries
// any deeper indent of its own.
function block(depth: number, title: string, lines: readonly string[]): string[] {
  const inner = lines.length === 0 ? ["none"] : lines;
  return [`${indent(depth)}${title}`, ...inner.map((line) => `${indent(depth + 1)}${line}`)];
}

function memberLines(members: readonly HexagonMember[]): string[] {
  return members.map((member) => {
    const signature =
      member.signature !== null && member.signature !== member.type ? ` = ${member.signature}` : "";
    return `${member.name}: ${member.type}${signature}`;
  });
}

// `access` is padded to the longest word, so the file column lines up.
const reachLine = ({ table, access, file, place }: FeatureReach): string =>
  `${table}  ${access.padEnd("foreign-key".length)}  ${file}  ${locusText(place)}`;

function featureLines(feature: OwnedFeature): string[] {
  const tables = feature.tables.length === 0 ? [] : [feature.tables.join(", ")];
  return [
    `${indent(1)}Feature ${feature.feature}`,
    ...block(2, "Tables", tables),
    ...block(2, "Reach into its tables", feature.reach.map(reachLine)),
    ...block(2, "Commands", memberLines(feature.commands)),
    ...block(2, "External systems", memberLines(feature.externalSystems)),
  ];
}

function bindingLines(row: BindingRow): string[] {
  const narrowed = row.owners.length === 0 ? "" : `, narrowed to ${row.owners.join(", ")}`;
  return [
    `${indent(1)}${row.binding} (${row.kind})${narrowed}`,
    ...row.sites.map((site) => `${indent(2)}${site.file}:${site.line}  ${locusText(site.place)}`),
  ];
}

const workerLines = (worker: WorkerRow): string[] => [
  worker.worker,
  ...worker.bindings.flatMap(bindingLines),
];

function technologyLines(row: TechnologyRow): string[] {
  const reach = row.reach.map(({ file, place }) => `${file}  ${locusText(place)}`);
  return [
    row.technology,
    `${indent(1)}root: ${row.root}`,
    `${indent(1)}modules: ${row.modules.join(", ")}`,
    ...block(1, "Imported from", reach),
  ];
}

function scopeLines(scope: ScopeOwners): string[] {
  return [
    scope.scope,
    ...(scope.features.length === 0
      ? block(1, "Features", [])
      : scope.features.flatMap(featureLines)),
    ...block(1, "Workers", scope.workers.flatMap(workerLines)),
    ...block(1, "Technologies", scope.technologies.flatMap(technologyLines)),
  ];
}

export function renderOwners(report: OwnersReport, json: boolean, pretty: boolean): string {
  if (json) return stableStringify(report, pretty);
  const scopes =
    report.scopes.length === 0 ? ["none"] : report.scopes.map((s) => scopeLines(s).join("\n"));
  const notRead = block(
    0,
    "Not read",
    report.notRead.map(({ file, reason }) => `${file}: ${reason}`),
  );
  return [...scopes, notRead.join("\n")].join("\n\n");
}
