import path from "node:path";
import type { Opts } from "../cli.js";
import type { Reporter } from "../config.js";
import { scopeOf } from "../ratchet/scope-count.js";
import type { Graph } from "../schema.js";
import {
  findingsOf,
  measuredRules,
  needsEdges,
  readSmellLedger,
  reconcileSmells,
  SMELL_LEDGER_FILENAME,
  type SmellLedger,
  withAcceptedSmells,
  writeSmellLedger,
} from "./ledger.js";
import { renderAcceptedSmells, renderSmellLedgerGate } from "./ledger-render.js";

export type SmellGateOpts = Pick<
  Opts,
  | "ci"
  | "acceptSmells"
  | "reason"
  | "unreachable"
  | "boundaries"
  | "comments"
  | "collapse"
  | "layers"
>;

type SmellGateFlags = {
  readonly ci: boolean;
  readonly acceptSmells: boolean;
  // `--ci` belongs to another gate (or that gate runs on its own) when one of these is given.
  readonly otherGate: boolean;
  // The trimmed `--reason`, or null when none was given.
  readonly reason: string | null;
};

function flagsOf(opts: SmellGateOpts): SmellGateFlags {
  return {
    ci: opts.ci === true,
    acceptSmells: opts.acceptSmells === true,
    otherGate:
      opts.unreachable === true ||
      opts.boundaries === true ||
      opts.comments === true ||
      opts.collapse === true ||
      opts.layers === true,
    reason: opts.reason === undefined ? null : opts.reason.trim(),
  };
}

// Each flag combination `--accept-smells` refuses, in the order they are checked.
const REFUSALS: readonly { refuses: (f: SmellGateFlags) => boolean; message: string }[] = [
  {
    refuses: (f) => f.acceptSmells && f.otherGate,
    message:
      "--accept-smells runs on its own, not with --unreachable, --boundaries, --comments, --collapse or --layers; nothing was written.",
  },
  {
    refuses: (f) => f.acceptSmells && f.ci,
    message: "pass one of --ci, --accept-smells; nothing was written.",
  },
  {
    refuses: (f) => f.acceptSmells && (f.reason ?? "") === "",
    message: '`--accept-smells` needs a non-empty `--reason "<why>"`; nothing was written.',
  },
];

type SmellGateMode =
  | { readonly kind: "gate" }
  | { readonly kind: "accept"; readonly reason: string };

export type PreparedSmellGate = {
  readonly mode: SmellGateMode;
  readonly file: string;
  readonly scope: string;
  readonly ledger: SmellLedger;
};

// `none` is today's smell gate (or no gate at all): the run gates no rule, or is not a smell gate.
export type SmellGatePreparation =
  | { readonly kind: "none" }
  | { readonly kind: "refused" }
  | { readonly kind: "prepared"; readonly gate: PreparedSmellGate };

type Refused = { readonly kind: "refused"; readonly message: string };

// What the flags ask of the smell ledger: nothing, a refusal, or a mode.
function modeOf(
  flags: SmellGateFlags,
): { readonly kind: "none" } | Refused | { readonly kind: "mode"; readonly mode: SmellGateMode } {
  const refusal = REFUSALS.find((rule) => rule.refuses(flags));
  if (refusal !== undefined) return { kind: "refused", message: refusal.message };
  if (flags.acceptSmells)
    return { kind: "mode", mode: { kind: "accept", reason: flags.reason ?? "" } };
  if (flags.ci && !flags.otherGate) return { kind: "mode", mode: { kind: "gate" } };
  return { kind: "none" };
}

// The ledger a mode runs on, or `none` when `--ci` finds no rule gated and so stays today's gate.
function gatedLedgerOf(
  mode: SmellGateMode,
  file: string,
): { readonly kind: "none" } | Refused | { readonly kind: "read"; readonly ledger: SmellLedger } {
  const read = readSmellLedger(file);
  if (read.kind === "invalid") {
    return {
      kind: "refused",
      message: `invalid smell ledger "${file}": ${read.message}; nothing was written.`,
    };
  }
  if (read.kind === "read" && read.ledger.gated.length > 0) return read;
  if (mode.kind === "gate") return { kind: "none" };
  return {
    kind: "refused",
    message: `--accept-smells: no smell rule is gated; name the rules in the "gated" list of "${file}" first; nothing was written.`,
  };
}

// Resolves the mode and reads the ledger, both before the analysis: a refused flag set, a ledger
// that does not parse or names an unknown rule, and an accept with no gated rule all exit 2 here,
// so a run that cannot gate never measures or writes.
export function prepareSmellGate(
  opts: SmellGateOpts,
  rootAbsolute: string,
  repoRoot: string,
  report: Reporter,
): SmellGatePreparation {
  const mode = modeOf(flagsOf(opts));
  if (mode.kind === "none") return mode;
  const file = path.join(repoRoot, SMELL_LEDGER_FILENAME);
  const ledger = mode.kind === "mode" ? gatedLedgerOf(mode.mode, file) : mode;
  if (ledger.kind === "refused") {
    report(ledger.message);
    return { kind: "refused" };
  }
  if (ledger.kind === "none" || mode.kind !== "mode") return { kind: "none" };
  const scope = scopeOf(repoRoot, rootAbsolute);
  return { kind: "prepared", gate: { mode: mode.mode, file, scope, ledger: ledger.ledger } };
}

// Whether the analysis must run the edge pass: a gated rule only the edge pass measures.
export function smellGateNeedsEdges(preparation: SmellGatePreparation): boolean {
  return preparation.kind === "prepared" && needsEdges(preparation.gate.ledger.gated);
}

export type SmellGateOutput = {
  readonly emit: (payload: string) => void;
  readonly json: boolean;
  readonly pretty: boolean;
};

export function runSmellLedgerGate(
  gate: PreparedSmellGate,
  graph: Graph,
  out: SmellGateOutput,
): number {
  const findings = findingsOf(gate.scope, graph.smells);
  const result = reconcileSmells(gate.ledger, gate.scope, findings, measuredRules(graph));
  const { mode } = gate;
  switch (mode.kind) {
    case "gate": {
      if (result.pruned.length > 0 || result.lowered.length > 0) {
        writeSmellLedger(gate.file, result.kept);
      }
      const { stdout, exitCode } = renderSmellLedgerGate(result, out.json, out.pretty);
      out.emit(`${stdout}\n`);
      return exitCode;
    }
    case "accept": {
      const changed =
        result.pruned.length +
        result.lowered.length +
        result.unrecorded.length +
        result.worsened.length;
      if (changed > 0) writeSmellLedger(gate.file, withAcceptedSmells(result, mode.reason));
      out.emit(`${renderAcceptedSmells(result, mode.reason, out.json, out.pretty)}\n`);
      return 0;
    }
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
