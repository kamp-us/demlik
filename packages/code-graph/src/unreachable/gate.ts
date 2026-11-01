import path from "node:path";
import type { Opts } from "../cli.js";
import type { Reporter } from "../config.js";
import { scopeOf } from "../ratchet/scope-count.js";
import {
  type Graph,
  type UnreachableFindingKind,
  UnreachableFindingKindSchema,
} from "../schema.js";
import {
  findingsOf,
  readUnreachableLedger,
  reconcileUnreachable,
  UNREACHABLE_LEDGER_FILENAME,
  type UnreachableLedger,
  withAcceptedFindings,
  writeUnreachableLedger,
} from "./ledger.js";
import { renderAcceptedDead, renderUnreachableGate } from "./render.js";

export type UnreachableOpts = Pick<
  Opts,
  "unreachable" | "ci" | "acceptDead" | "deadOnly" | "boundaries" | "reason"
>;

type UnreachableFlags = {
  readonly unreachable: boolean;
  readonly ci: boolean;
  readonly acceptDead: boolean;
  readonly deadOnly: boolean;
  readonly boundaries: boolean;
  // The trimmed `--reason`, or null when none was given.
  readonly reason: string | null;
};

function flagsOf(opts: UnreachableOpts): UnreachableFlags {
  return {
    unreachable: opts.unreachable === true,
    ci: opts.ci === true,
    acceptDead: opts.acceptDead === true,
    deadOnly: opts.deadOnly === true,
    boundaries: opts.boundaries === true,
    reason: opts.reason === undefined ? null : opts.reason.trim(),
  };
}

const ALL_KINDS: readonly UnreachableFindingKind[] = UnreachableFindingKindSchema.options;
// `--dead-only` leaves `only-called-from-tests` and `unused-export` out: neither fails nor is pruned.
const DEAD_ONLY: readonly UnreachableFindingKind[] = ["dead"];

type UnreachableMode =
  | { readonly kind: "gate"; readonly gated: readonly UnreachableFindingKind[] }
  | { readonly kind: "accept"; readonly reason: string };

// What the flags ask of the unreachable gate: nothing (`none`), a refusal already reported, or a
// mode. Decided before any analysis runs, so a refused run reads and writes nothing.
type ModeRead =
  | { readonly kind: "none" }
  | { readonly kind: "refused" }
  | { readonly kind: "mode"; readonly mode: UnreachableMode };

// Each flag combination the gate refuses, in the order they are checked. A `--reason` with no
// `--unreachable` is the boundary gate's to judge, as it was before this gate existed.
const REFUSALS: readonly { refuses: (f: UnreachableFlags) => boolean; message: string }[] = [
  {
    refuses: (f) => f.acceptDead && !f.unreachable,
    message: "--accept-dead only rides --unreachable; nothing was written.",
  },
  {
    refuses: (f) => f.deadOnly && !(f.unreachable && f.ci),
    message: "--dead-only only rides --unreachable --ci; nothing was written.",
  },
  {
    refuses: (f) => f.acceptDead && f.ci,
    message: "pass one of --ci, --accept-dead with --unreachable; nothing was written.",
  },
  {
    refuses: (f) => f.acceptDead && (f.reason ?? "") === "",
    message: '`--accept-dead` needs a non-empty `--reason "<why>"`; nothing was written.',
  },
  {
    refuses: (f) => f.unreachable && f.reason !== null && !f.acceptDead && !f.boundaries,
    message:
      "--reason only rides `--unreachable --accept-dead` or `--boundaries --accept-crossings`.",
  },
];

function modeOf(flags: UnreachableFlags, report: Reporter): ModeRead {
  const refusal = REFUSALS.find((rule) => rule.refuses(flags));
  if (refusal !== undefined) {
    report(refusal.message);
    return { kind: "refused" };
  }
  if (!flags.unreachable) return { kind: "none" };
  if (flags.acceptDead) {
    return { kind: "mode", mode: { kind: "accept", reason: flags.reason ?? "" } };
  }
  if (flags.ci) {
    return { kind: "mode", mode: { kind: "gate", gated: flags.deadOnly ? DEAD_ONLY : ALL_KINDS } };
  }
  return { kind: "none" };
}

export type PreparedUnreachableGate = {
  readonly mode: UnreachableMode;
  readonly file: string;
  readonly scope: string;
  readonly ledger: UnreachableLedger;
};

export type Preparation =
  | { readonly kind: "none" }
  | { readonly kind: "refused" }
  | { readonly kind: "prepared"; readonly gate: PreparedUnreachableGate };

// Resolves the mode and reads the ledger, both before the analysis: an unreadable or
// schema-invalid ledger is refused here, so a run that cannot gate never measures or writes.
export function prepareUnreachableGate(
  opts: UnreachableOpts,
  rootAbsolute: string,
  repoRoot: string,
  report: Reporter,
): Preparation {
  const read = modeOf(flagsOf(opts), report);
  if (read.kind !== "mode") return read;
  const file = path.join(repoRoot, UNREACHABLE_LEDGER_FILENAME);
  const ledger = readUnreachableLedger(file);
  if (ledger.kind === "invalid") {
    report(`invalid unreachable ledger "${file}": ${ledger.message}; nothing was written.`);
    return { kind: "refused" };
  }
  return {
    kind: "prepared",
    gate: {
      mode: read.mode,
      file,
      scope: scopeOf(repoRoot, rootAbsolute),
      ledger: ledger.kind === "read" ? ledger.ledger : { entries: [] },
    },
  };
}

export type UnreachableOutput = {
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
};

export function runUnreachableGate(
  gate: PreparedUnreachableGate,
  graph: Graph,
  out: UnreachableOutput,
): number {
  if (graph.reachability === null) {
    out.report("the reachability pass did not run; the unreachable gate has nothing to read.");
    return 2;
  }
  const findings = findingsOf(gate.scope, graph.reachability);
  const { mode } = gate;
  switch (mode.kind) {
    case "gate": {
      const result = reconcileUnreachable(gate.ledger, gate.scope, findings, mode.gated);
      if (result.pruned.length > 0) writeUnreachableLedger(gate.file, result.kept);
      const { stdout, exitCode } = renderUnreachableGate(result, out.json, out.pretty);
      out.emit(`${stdout}\n`);
      return exitCode;
    }
    case "accept": {
      const result = reconcileUnreachable(gate.ledger, gate.scope, findings, ALL_KINDS);
      if (result.pruned.length > 0 || result.unrecorded.length > 0) {
        writeUnreachableLedger(
          gate.file,
          withAcceptedFindings(result.kept, result.unrecorded, mode.reason),
        );
      }
      out.emit(`${renderAcceptedDead(result, mode.reason, out.json, out.pretty)}\n`);
      return 0;
    }
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}
