import type { Opts } from "../cli.js";

type OneGateOpts = Pick<
  Opts,
  | "layers"
  | "boundaries"
  | "comments"
  | "collapse"
  | "unreachable"
  | "ci"
  | "writeCeilings"
  | "acceptCrossings"
  | "acceptDead"
  | "migrateCeilings"
  | "acceptSmells"
  | "hexagon"
  | "envKeys"
  | "owners"
>;

// `--layers` always gates. These four only report until a flag points them at their ledger or
// ceilings file; that flag is shared across the run, so it arms every one of them that is given.
const armsGate = (opts: OneGateOpts): boolean =>
  opts.ci === true ||
  opts.writeCeilings === true ||
  opts.acceptCrossings === true ||
  opts.acceptDead === true ||
  opts.migrateCeilings === true;

function namedGates(opts: OneGateOpts): string[] {
  const armed = armsGate(opts);
  const given: readonly (readonly [boolean, string])[] = [
    [opts.layers === true, "--layers"],
    [armed && opts.boundaries === true, "--boundaries"],
    [armed && opts.comments === true, "--comments"],
    [armed && opts.collapse === true, "--collapse"],
    [armed && opts.unreachable === true, "--unreachable"],
  ];
  return given.filter(([isGiven]) => isGiven).map(([, flag]) => flag);
}

// With no named gate, `--ci` is the smell gate, and `--accept-smells` writes its ledger. Beside a
// named gate `--ci` only arms that gate, and `prepareSmellGate` refuses `--accept-smells` there.
function smellGate(opts: OneGateOpts): string[] {
  if (opts.ci === true) return ["--ci"];
  return opts.acceptSmells === true ? ["--accept-smells"] : [];
}

// These answer with a report and return before any gate would run.
function gatelessModes(opts: OneGateOpts): string[] {
  return [
    ...(opts.hexagon === true ? ["--hexagon"] : []),
    ...(opts.envKeys === true ? ["--env-keys"] : []),
    ...(opts.owners === true ? ["--owners"] : []),
  ];
}

// The run answers with the first mode its flags reach, so a second gate would never run and the
// exit code would say nothing about it. `--owners` is the one report that takes no other mode: it
// answers after `--hexagon` and before any gate, so a mode beside it would never run. Decided from
// the flags alone, before any ledger is read.
export function oneGateRefusal(opts: OneGateOpts): string | null {
  const named = namedGates(opts);
  const gates = named.length > 0 ? named : smellGate(opts);
  const gateless = gatelessModes(opts);
  const clashes =
    gates.length > 1 ||
    (gates.length === 1 && gateless.length > 0) ||
    (opts.owners === true && gateless.length > 1);
  if (!clashes) return null;
  return `a run takes one gate, and --hexagon, --env-keys and --owners run without one; got ${[...gateless, ...gates].join(", ")}; no ledger was read or written.`;
}
