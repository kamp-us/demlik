import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BoundaryFlags, runBoundaryGate } from "../boundaries/gate.js";
import { LEDGER_FILENAME } from "../boundaries/ledger.js";
import { LEGACY_CEILINGS_FILENAME } from "../boundaries/rules.js";
import { runOwners } from "../owners/run.js";

export type GateRun = { readonly code: number; readonly stdout: string; readonly errors: string[] };

export type GateOptions = Partial<BoundaryFlags> & {
  readonly json?: boolean;
  readonly rules?: string;
  // The repo-relative path the run is pointed at, where the CLI would be given one: the repo's own
  // scope when absent.
  readonly at?: string;
};

export type OwnersOptions = Pick<GateOptions, "json" | "rules" | "at">;

// A throwaway repo with one declared boundary scope, driven through the same gate the CLI calls.
export type BoundaryRepo = {
  readonly root: string;
  readonly rulesFile: string;
  readonly ledgerFile: string;
  readonly legacyFile: string;
  readonly put: (rel: string, body: string) => void;
  readonly remove: (rel: string) => void;
  readonly run: (options?: GateOptions) => GateRun;
  readonly owners: (options?: OwnersOptions) => GateRun;
  readonly dispose: () => void;
};

type Where = { readonly root: string; readonly scope: string; readonly rulesFile: string };

// What a run prints and reports, collected to hand back with its exit code.
function sink() {
  const out: string[] = [];
  const errors: string[] = [];
  return {
    emit: (payload: string) => {
      out.push(payload);
    },
    report: (message: string) => {
      errors.push(message);
    },
    finish: (code: number): GateRun => ({ code, stdout: out.join(""), errors }),
  };
}

function runGate({ root, scope, rulesFile }: Where, options: GateOptions): GateRun {
  const { emit, report, finish } = sink();
  return finish(
    runBoundaryGate({
      rootAbsolute: path.join(root, options.at ?? scope),
      repoRoot: root,
      boundaryRulesFile: options.rules ?? rulesFile,
      ci: options.ci === true,
      writeCeilings: options.writeCeilings === true,
      acceptCrossings: options.acceptCrossings === true,
      reason: options.reason,
      migrateCeilings: options.migrateCeilings === true,
      emit,
      report,
      json: options.json === true,
      pretty: false,
    }),
  );
}

function runOwnersView({ root, scope, rulesFile }: Where, options: OwnersOptions): GateRun {
  const { emit, report, finish } = sink();
  return finish(
    runOwners(
      path.join(root, options.at ?? scope),
      options.rules ?? rulesFile,
      { json: options.json === true, pretty: false, emit, report },
      root,
    ),
  );
}

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
  const where: Where = { root, scope, rulesFile };

  return {
    root,
    rulesFile,
    ledgerFile: path.join(root, LEDGER_FILENAME),
    legacyFile: path.join(root, LEGACY_CEILINGS_FILENAME),
    put,
    remove: (rel) => fs.rmSync(path.join(root, scope, rel)),
    run: (options = {}) => runGate(where, options),
    owners: (options = {}) => runOwnersView(where, options),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
