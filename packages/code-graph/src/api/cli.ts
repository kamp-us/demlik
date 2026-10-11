import fs from "node:fs";
import { stableStringify } from "../render/json.js";
import { diffPublishedApi } from "./diff.js";
import { ApiInputError } from "./map.js";
import { readChangesetsSince } from "./ratchet/changesets.js";
import { bumpPolicy } from "./ratchet/policy.js";
import { renderApiRatchet } from "./ratchet/text.js";
import { apiChanges, ratchetApiDiff } from "./ratchet/verdict.js";
import { readPublishedApi } from "./view.js";

// The flags `--api` combines with (SPEC §13.6); any other flag given on the command line exits 2.
const API_COMPANIONS: ReadonlySet<string> = new Set([
  ...["api", "apiBase", "apiPolicy"],
  ...["json", "pretty", "out"],
]);

export type ApiRun = {
  readonly rootAbsolute: string;
  readonly mapFile: string;
  // `--api-base`: when set, the run diffs against this rev instead of printing the view.
  readonly base: string | undefined;
  // `--api-policy`: when set, the run judges the diff against this policy instead of printing it.
  readonly policyFile: string | undefined;
  // Every option the command line itself gave, by its attribute name.
  readonly given: readonly string[];
  // `--json`: the ratchet prints its verdict as JSON; the view and the diff are JSON either way.
  readonly json: boolean;
  readonly pretty: boolean;
  readonly emit: (payload: string) => void;
  readonly report: (message: string) => void;
};

// The mode's three flags as the command line gave them.
export type ApiFlags = {
  readonly api?: string;
  readonly apiBase?: string;
  readonly apiPolicy?: string;
};

type ApiOutcome = { readonly payload: string; readonly code: number };

function readJsonFile(file: string, what: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ApiInputError(`cannot read ${what} "${file}"`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiInputError(`${what} "${file}" is not valid JSON`);
  }
}

const flagOf = (attribute: string): string =>
  `--${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

// The ratchet (SPEC §13.5): the diff, the package's changesets since the diff's base, and the
// verdict. The policy is parsed before the diff runs, so a bad one is refused before any emit.
async function ratchet(
  run: ApiRun,
  map: unknown,
  base: string,
  policyFile: string,
): Promise<ApiOutcome> {
  const policy = bumpPolicy(readJsonFile(policyFile, "bump policy"));
  const diff = await diffPublishedApi(run.rootAbsolute, map, base);
  const verdict = ratchetApiDiff(diff, policy, readChangesetsSince(run.rootAbsolute, diff.base));
  const payload = run.json
    ? `${stableStringify(verdict, run.pretty)}\n`
    : renderApiRatchet(verdict, { changes: apiChanges(diff).length, callout: policy.callout });
  return { payload, code: verdict.passed ? 0 : 1 };
}

async function outcomeOf(run: ApiRun): Promise<ApiOutcome> {
  const map = readJsonFile(run.mapFile, "API map");
  if (run.base !== undefined && run.policyFile !== undefined) {
    return ratchet(run, map, run.base, run.policyFile);
  }
  const result =
    run.base === undefined
      ? await readPublishedApi(run.rootAbsolute, map)
      : await diffPublishedApi(run.rootAbsolute, map, run.base);
  return { payload: `${stableStringify(result, run.pretty)}\n`, code: 0 };
}

// A thin caller of the `@demlik/code-graph/api` exports: it holds no logic of its own beyond
// reading the map and policy files and refusing flags the mode does not take. Resolves to the exit
// code: 0, 1 when the ratchet finds a miss, 2 on a refused input, and `API_CRASH_EXIT` on any other
// error, so it never rejects and a crash never reads as Node's exit 1, the ratchet's miss.
export const API_CRASH_EXIT = 3;

// One line for whatever was thrown: an error's message can span several.
const crashLine = (error: unknown): string =>
  `unexpected error: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim()}`;

export async function runApiView(run: ApiRun): Promise<number> {
  const stray = run.given.filter((attribute) => !API_COMPANIONS.has(attribute));
  if (stray.length > 0) {
    run.report(
      `--api takes only --api-base, --api-policy, --json, --pretty and --out; got ${stray.map(flagOf).join(", ")}`,
    );
    return 2;
  }
  if (run.policyFile !== undefined && run.base === undefined) {
    run.report("--api-policy needs --api-base <rev>");
    return 2;
  }
  try {
    const { payload, code } = await outcomeOf(run);
    run.emit(payload);
    return code;
  } catch (error) {
    if (error instanceof ApiInputError) {
      run.report(error.message);
      return 2;
    }
    run.report(crashLine(error));
    return API_CRASH_EXIT;
  }
}

// The command line's entry to the mode: `null` when none of its flags is given, so every other
// mode runs as before; otherwise the run's exit code. `--api-base` and `--api-policy` without
// `--api` are refused here (SPEC §13.6).
export function runApiFlags(
  flags: ApiFlags,
  host: Omit<ApiRun, "mapFile" | "base" | "policyFile">,
): Promise<number> | null {
  if (flags.api !== undefined) {
    return runApiView({
      ...host,
      mapFile: flags.api,
      base: flags.apiBase,
      policyFile: flags.apiPolicy,
    });
  }
  if (flags.apiBase === undefined && flags.apiPolicy === undefined) return null;
  host.report(
    flags.apiBase === undefined
      ? "--api-policy needs --api <map> --api-base <rev>"
      : "--api-base needs --api <map>",
  );
  return Promise.resolve(2);
}
