import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineProgram, type Opts } from "../../packages/code-graph/src/cli.js";
import {
  resolveCollapseSettings,
  resolveNodeKindRules,
  resolveThresholds,
  withEntryPresets,
} from "../../packages/code-graph/src/config.js";
import { findRepoRoot } from "../../packages/code-graph/src/extract/project.js";
import {
  prepareSmellGate,
  smellGateNeedsEdges,
} from "../../packages/code-graph/src/smells/gate.js";
import {
  needsEdges,
  parseSmellLedger,
  readSmellLedger,
  smellKey,
  smellLedgerOf,
} from "../../packages/code-graph/src/smells/ledger.js";
import { smellKinds } from "../../packages/code-graph/src/smells/rules.js";
import { prepareUnreachableGate } from "../../packages/code-graph/src/unreachable/gate.js";
import {
  findingKey,
  parseUnreachableLedger,
  readUnreachableLedger,
  unreachableLedgerOf,
} from "../../packages/code-graph/src/unreachable/ledger.js";

export const KINDS = smellKinds();
const numericInput = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
export type NumberInput = z.infer<typeof numericInput>;
export function numeric(value: NumberInput): number {
  return typeof value === "number"
    ? value
    : {
        NaN: Number.NaN,
        Infinity: Number.POSITIVE_INFINITY,
        "-Infinity": Number.NEGATIVE_INFINITY,
        "-0": -0,
      }[value];
}
export function numberKind(value: number): string {
  return Number.isNaN(value)
    ? "NaN"
    : value === Number.POSITIVE_INFINITY
      ? "Infinity"
      : value === Number.NEGATIVE_INFINITY
        ? "-Infinity"
        : Object.is(value, -0)
          ? "-0"
          : "number";
}
const unreachableEntry = z
  .object({
    scope: z.string(),
    kind: z.enum(["dead", "only-called-from-tests"]),
    id: z.string(),
    reason: z.string(),
  })
  .strict();
const smellEntry = z
  .object({
    rule: z.enum(KINDS),
    target: z.string(),
    value: numericInput,
    reason: z.string(),
  })
  .strict();
const unreachableOpts = z
  .object({
    unreachable: z.boolean().optional(),
    ci: z.boolean().optional(),
    acceptDead: z.boolean().optional(),
    deadOnly: z.boolean().optional(),
    boundaries: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();
const smellOpts = z
  .object({
    ci: z.boolean().optional(),
    acceptSmells: z.boolean().optional(),
    unreachable: z.boolean().optional(),
    boundaries: z.boolean().optional(),
    comments: z.boolean().optional(),
    collapse: z.boolean().optional(),
    layers: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();
export const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("root"), root: z.string() }).strict(),
  z.object({ action: z.literal("json"), text: z.string() }).strict(),
  z
    .object({ action: z.literal("unreachable-parse"), text: z.string() })
    .strict(),
  z.object({ action: z.literal("smell-parse"), text: z.string() }).strict(),
  z
    .object({ action: z.literal("unreachable-read"), file: z.string() })
    .strict(),
  z.object({ action: z.literal("smell-read"), file: z.string() }).strict(),
  z
    .object({
      action: z.literal("unreachable-of"),
      entries: z.array(unreachableEntry),
    })
    .strict(),
  z
    .object({
      action: z.literal("smell-of"),
      gated: z.array(z.enum(KINDS)),
      entries: z.array(smellEntry),
    })
    .strict(),
  z
    .object({ action: z.literal("needs-edges"), gated: z.array(z.enum(KINDS)) })
    .strict(),
  z
    .object({
      action: z.literal("prepare-unreachable"),
      root: z.string(),
      repoRoot: z.string(),
      opts: unreachableOpts,
    })
    .strict(),
  z
    .object({
      action: z.literal("prepare-smell"),
      root: z.string(),
      repoRoot: z.string(),
      opts: smellOpts,
    })
    .strict(),
  z
    .object({
      action: z.literal("frontdoor"),
      argv: z.array(z.string()),
      initial: z.number().int().min(-2147483648).max(2147483647).optional(),
    })
    .strict(),
]);
export type Input = z.infer<typeof InputSchema>;
export function reference(input: Input): { output: unknown; details: unknown } {
  let details: unknown = null;
  try {
    let value: unknown;
    switch (input.action) {
      case "root":
        value = findRepoRoot(input.root);
        break;
      case "json": {
        try {
          return {
            output: { accepted: true, value: JSON.parse(input.text) },
            details: null,
          };
        } catch {
          return { output: { accepted: false }, details: null };
        }
      }
      case "unreachable-parse":
        value = parseUnreachableLedger(input.text);
        break;
      case "unreachable-read":
        value = readUnreachableLedger(input.file);
        break;
      case "smell-parse":
      case "smell-read": {
        const read =
          input.action === "smell-parse"
            ? parseSmellLedger(input.text)
            : readSmellLedger(input.file);
        value = read;
        if (read.kind === "read")
          details = read.ledger.entries.map((entry) => numberKind(entry.value));
        break;
      }
      case "unreachable-of": {
        const ledger = unreachableLedgerOf(input.entries);
        value = {
          ledger,
          origin: ledger.entries.map((entry) => input.entries.indexOf(entry)),
          keys: input.entries.map(findingKey),
        };
        break;
      }
      case "smell-of": {
        const entries = input.entries.map((entry) => ({
          ...entry,
          value: numeric(entry.value),
        }));
        const ledger = smellLedgerOf(input.gated, entries);
        value = {
          ledger,
          origin: ledger.entries.map((entry) => entries.indexOf(entry)),
          keys: entries.map(smellKey),
          numberKinds: ledger.entries.map((entry) => numberKind(entry.value)),
        };
        break;
      }
      case "needs-edges":
        value = needsEdges(input.gated);
        break;
      case "prepare-unreachable": {
        const reports: string[] = [];
        value = {
          preparation: prepareUnreachableGate(
            input.opts,
            input.root,
            input.repoRoot,
            (message) => {
              reports.push(message);
            },
          ),
          reports,
        };
        break;
      }
      case "prepare-smell": {
        const reports: string[] = [];
        value = {
          preparation: prepareSmellGate(
            input.opts,
            input.root,
            input.repoRoot,
            (message) => {
              reports.push(message);
            },
          ),
          reports,
        };
        break;
      }
      case "frontdoor":
        return { output: preparedReference(input), details: null };
    }
    return { output: { value, thrown: null }, details };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      output: {
        value: null,
        thrown: { name: error.name, message: error.message },
      },
      details,
    };
  }
}
// A component reference deliberately stops at index.ts114. Later CLI modes are not executed.
function preparedReference(
  input: Extract<Input, { action: "frontdoor" }>,
): unknown {
  const command = defineProgram()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
  command.parse(input.argv, { from: "user" });
  const opts = command.opts<Opts>();
  const root = fs.realpathSync(path.resolve(command.args[0] ?? ""));
  const report = (message: string): never => {
    throw new Error(`unexpected prelude refusal: ${message}`);
  };
  const thresholds = resolveThresholds(opts.thresholds, report);
  const fileRules = resolveNodeKindRules(opts.nodeKinds, report);
  if (thresholds === null || fileRules === null)
    throw new Error("prelude refused");
  const kindRules = withEntryPresets(fileRules, opts.entryPreset ?? [], report);
  const collapse = resolveCollapseSettings(opts.collapseConfig, report);
  if (kindRules === null || collapse === null)
    throw new Error("prelude refused");
  const repoRoot = findRepoRoot(root);
  const reports: string[] = [];
  const unreachable = prepareUnreachableGate(
    opts,
    root,
    repoRoot,
    (message) => {
      reports.push(message);
    },
  );
  if (unreachable.kind === "refused")
    throw new Error(
      `component case refused unreachable: ${reports.join("; ")}`,
    );
  const smells = prepareSmellGate(opts, root, repoRoot, (message) => {
    reports.push(message);
  });
  if (smells.kind === "refused")
    throw new Error(`component case refused smell: ${reports.join("; ")}`);
  return {
    kind: "ready",
    root,
    repoRoot,
    options: opts,
    thresholds,
    kindRules,
    collapse,
    given: Object.keys(opts).filter(
      (key) => command.getOptionValueSource(key) === "cli",
    ),
    unreachable,
    smells,
    needsEdges: smellGateNeedsEdges(smells),
    io: { stored: input.initial ?? null, requested: null, pending: [] },
  };
}
