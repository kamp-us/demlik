import fs from "node:fs";
import path from "node:path";
import { type Reporter, resolveCommentCeilings } from "../config.js";
import { stableStringify } from "../render/json.js";
import { CEILINGS_FILENAME, ceilingsFromCensus } from "./ceilings.js";
import { loadCommentCensus } from "./census.js";
import { evaluateRatchet, renderRatchet } from "./ratchet.js";
import { renderComments } from "./render.js";

export type CommentGateArgs = {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly ci: boolean;
  readonly writeCeilings: boolean;
  readonly emit: (payload: string) => void;
  readonly report: Reporter;
  readonly json: boolean;
  readonly pretty: boolean;
};

export function runCommentGate(args: CommentGateArgs): number {
  if (!args.ci && !args.writeCeilings) {
    args.emit(`${renderComments(loadCommentCensus(args.rootAbsolute), args.json, args.pretty)}\n`);
    return 0;
  }

  const file = path.join(args.repoRoot, CEILINGS_FILENAME);
  const exists = fs.existsSync(file);
  const ceilings = resolveCommentCeilings(exists || args.ci ? file : undefined, args.report);
  if (ceilings === null) return 2;

  const census = loadCommentCensus(args.rootAbsolute);

  if (args.writeCeilings) {
    const recorded = ceilingsFromCensus(census, ceilings);
    fs.writeFileSync(file, `${stableStringify(recorded, true)}\n`);
    args.emit(`wrote ${Object.keys(recorded.scopes).length} scope ceiling(s) to ${file}\n`);
    return 0;
  }

  const { stdout, exitCode } = renderRatchet(
    evaluateRatchet(census, ceilings),
    args.json,
    args.pretty,
  );
  args.emit(`${stdout}\n`);
  return exitCode;
}
