import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BoundaryFlags, runBoundaryGate } from "../boundaries/gate.js";
import { LEDGER_FILENAME } from "../boundaries/ledger.js";
import { LEGACY_CEILINGS_FILENAME } from "../boundaries/rules.js";

export type GateRun = { readonly code: number; readonly stdout: string; readonly errors: string[] };

export type GateOptions = Partial<BoundaryFlags> & {
  readonly json?: boolean;
  readonly rules?: string;
};

// A throwaway repo with one declared boundary scope, driven through the same gate the CLI calls.
export type BoundaryRepo = {
  readonly root: string;
  readonly rulesFile: string;
  readonly ledgerFile: string;
  readonly legacyFile: string;
  readonly put: (rel: string, body: string) => void;
  readonly remove: (rel: string) => void;
  readonly run: (options?: GateOptions) => GateRun;
  readonly dispose: () => void;
};

export function boundaryRepo(
  scope: string,
  files: Readonly<Record<string, string>>,
  rules: unknown,
): BoundaryRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-boundaries-"));
  const put = (rel: string, body: string) => {
    const file = path.join(root, scope, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  const rulesFile = path.join(root, "boundaries.json");
  fs.writeFileSync(rulesFile, JSON.stringify(rules));

  const run = (options: GateOptions = {}): GateRun => {
    const out: string[] = [];
    const errors: string[] = [];
    const code = runBoundaryGate({
      rootAbsolute: path.join(root, scope),
      repoRoot: root,
      boundaryRulesFile: options.rules ?? rulesFile,
      ci: options.ci === true,
      writeCeilings: options.writeCeilings === true,
      acceptCrossings: options.acceptCrossings === true,
      reason: options.reason,
      migrateCeilings: options.migrateCeilings === true,
      emit: (payload) => {
        out.push(payload);
      },
      report: (message) => {
        errors.push(message);
      },
      json: options.json === true,
      pretty: false,
    });
    return { code, stdout: out.join(""), errors };
  };

  return {
    root,
    rulesFile,
    ledgerFile: path.join(root, LEDGER_FILENAME),
    legacyFile: path.join(root, LEGACY_CEILINGS_FILENAME),
    put,
    remove: (rel) => fs.rmSync(path.join(root, scope, rel)),
    run,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
