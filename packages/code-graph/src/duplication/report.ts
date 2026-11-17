import type { Opts } from "../cli.js";
import { loadOverrides, type Reporter } from "../config.js";
import type { LoadedProject } from "../extract/project.js";
import { stableStringify } from "../render/json.js";
import type { Graph } from "../schema.js";
import { findExpressionClones } from "./clones.js";
import { findDataClumps } from "./clumps.js";
import type { Site } from "./scan.js";
import { type DuplicationSettings, DuplicationSettingsSchema } from "./settings.js";

const HUMAN_LIMIT = 20;

const GATE_FLAGS = [
  "ci",
  "layers",
  "writeCeilings",
  "acceptCrossings",
  "acceptDead",
  "acceptSmells",
  "migrateCeilings",
] satisfies readonly (keyof Opts)[];

export function duplicationRefusal(opts: Opts): string | null {
  if (!opts.clones && !opts.clumps) {
    return opts.duplicationConfig === undefined
      ? null
      : "--duplication-config needs --clones or --clumps";
  }
  const gate = GATE_FLAGS.some((flag) => opts[flag] === true);
  return gate ? "--clones and --clumps are reports; run gates separately" : null;
}

export function readDuplicationSettings(
  file: string | undefined,
  report: Reporter,
): DuplicationSettings | null {
  const defaults = DuplicationSettingsSchema.parse({});
  return file === undefined
    ? defaults
    : loadOverrides(file, DuplicationSettingsSchema.partial(), defaults, report);
}

const location = (site: Site): string => `${site.file}:${site.startLine}:${site.startColumn}`;

function cloneLines(clones: ReturnType<typeof findExpressionClones>): string[] {
  const lines = [`expression clones: ${clones.length}`];
  for (const clone of clones.slice(0, HUMAN_LIMIT)) {
    lines.push(`  ${clone.fileCount} files, ${clone.nodeCount} nodes: ${clone.expression}`);
    lines.push(...clone.sites.map((site) => `    ${location(site)}`));
  }
  return lines;
}

function clumpLines(report: ReturnType<typeof findDataClumps>): string[] {
  const lines = [`data clumps: ${report.clumps.length}`];
  for (const clump of report.clumps.slice(0, HUMAN_LIMIT)) {
    lines.push(`  ${clump.callee}: {${clump.values.join(", ")}} at ${clump.siteCount} sites`);
    lines.push(...clump.sites.map((site) => `    ${location(site)}`));
  }
  lines.push(`repeated arguments: ${report.repeatedArguments.length}`);
  for (const repeated of report.repeatedArguments.slice(0, HUMAN_LIMIT)) {
    lines.push(
      `  ${location(repeated.site)} ${repeated.callee}: ${repeated.value} in arguments ${repeated.arguments.map((a) => a.index).join(", ")} (zero-based)`,
    );
  }
  return lines;
}

export function renderDuplication(
  loaded: LoadedProject,
  graph: Graph,
  settings: DuplicationSettings,
  opts: Opts,
): string {
  const clones = opts.clones ? findExpressionClones(loaded, graph, settings) : null;
  const clumps = opts.clumps ? findDataClumps(loaded, graph, settings) : null;
  const report = {
    settings,
    parseFailures: [...loaded.parseFailures],
    ...(clones === null ? {} : { clones }),
    ...clumps,
  };
  if (opts.json) return stableStringify(report, opts.pretty === true);
  const lines = ["duplication: a report, never a gate; syntax matches need review"];
  if (clones !== null) lines.push(...cloneLines(clones));
  if (clumps !== null) lines.push(...clumpLines(clumps));
  for (const file of loaded.parseFailures) lines.push(`  cannot parse: ${file}`);
  return lines.join("\n");
}
