import fs from "node:fs";
import { stableStringify } from "../render/json.js";
import { ApiInputError } from "./map.js";
import { readPublishedApi } from "./view.js";

// The flags `--api` combines with (SPEC §13.6); any other flag given on the command line exits 2.
const API_COMPANIONS: ReadonlySet<string> = new Set(["api", "json", "pretty", "out"]);

export type ApiRun = {
  readonly rootAbsolute: string;
  readonly mapFile: string;
  // Every option the command line itself gave, by its attribute name.
  readonly given: readonly string[];
  readonly pretty: boolean;
  readonly emit: (payload: string) => void;
  readonly report: (message: string) => void;
};

function readMapFile(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ApiInputError(`cannot read API map "${file}"`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiInputError(`API map "${file}" is not valid JSON`);
  }
}

const flagOf = (attribute: string): string =>
  `--${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

// A thin caller of `readPublishedApi`: it holds no logic of its own beyond reading the map file
// and refusing flags the mode does not take. Resolves to the exit code.
export async function runApiView(run: ApiRun): Promise<number> {
  const stray = run.given.filter((attribute) => !API_COMPANIONS.has(attribute));
  if (stray.length > 0) {
    run.report(`--api takes only --json, --pretty and --out; got ${stray.map(flagOf).join(", ")}`);
    return 2;
  }
  try {
    const api = await readPublishedApi(run.rootAbsolute, readMapFile(run.mapFile));
    run.emit(`${stableStringify(api, run.pretty)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof ApiInputError)) throw error;
    run.report(error.message);
    return 2;
  }
}
