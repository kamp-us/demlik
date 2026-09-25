import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git, ignoredPaths } from "../git.js";

const Signal = z.object({
  signal: z.enum(["shape", "callees", "callers", "name"]),
  strength: z.number(),
  detail: z.string(),
});

const Candidate = z.object({
  aId: z.string(),
  aFile: z.string(),
  aStartLine: z.number(),
  aEndLine: z.number(),
  bId: z.string(),
  bFile: z.string(),
  bStartLine: z.number(),
  bEndLine: z.number(),
  signals: z.array(Signal),
  confidence: z.number(),
});

/** The part of `code-graph <scope> --collapse --json` this reads; every other field is ignored. */
const CollapseReport = z.object({ candidates: z.array(Candidate) });

export type GraphSignal = z.infer<typeof Signal>;

export const BODY_LIMIT = 4000;

export interface PairFunction {
  readonly path: string;
  readonly function: string;
  readonly lines: readonly [number, number];
  readonly source: string;
}

export interface Pair {
  readonly id: string;
  readonly scope: string;
  readonly a: PairFunction;
  readonly b: PairFunction;
  readonly signals: readonly GraphSignal[];
  readonly graphConfidence: number;
}

function functionName(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1);
}

function cut(text: string, start: number, end: number): string {
  const body = text
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
  return body.length <= BODY_LIMIT
    ? body
    : `${body.slice(0, BODY_LIMIT)}\n/* …truncated */`;
}

export function loadPairs(
  repoRoot: string,
  ref: string,
  scope: string,
  reportPath: string,
  log: (line: string) => void = () => {},
): Pair[] {
  const report = CollapseReport.parse(
    JSON.parse(readFileSync(reportPath, "utf8")),
  );
  const repoPath = (file: string) => join(scope, file);
  const ignored = ignoredPaths(repoRoot, [
    ...new Set(
      report.candidates.flatMap((c) => [repoPath(c.aFile), repoPath(c.bFile)]),
    ),
  ]);
  const texts = new Map<string, string>();
  const textOf = (path: string) => {
    const cached = texts.get(path);
    if (cached !== undefined) return cached;
    const text = git(repoRoot, ["show", `${ref}:${path}`]);
    texts.set(path, text);
    return text;
  };
  const side = (
    id: string,
    file: string,
    start: number,
    end: number,
  ): PairFunction | undefined => {
    const path = repoPath(file);
    const name = functionName(id);
    const source = cut(textOf(path), start, end);
    const bare = name.replace(/#\d+$/, "");
    if (!source.includes(bare)) {
      log(
        `${path}:${start} does not contain ${bare} at ${ref}; is --ref the graphed tree?`,
      );
      return undefined;
    }
    return { path, function: name, lines: [start, end], source };
  };
  return report.candidates.flatMap((c) => {
    if (ignored.has(repoPath(c.aFile)) || ignored.has(repoPath(c.bFile)))
      return [];
    const a = side(c.aId, c.aFile, c.aStartLine, c.aEndLine);
    const b = side(c.bId, c.bFile, c.bStartLine, c.bEndLine);
    if (a === undefined || b === undefined) return [];
    const id = createHash("sha256")
      .update([a.source, b.source].sort().join("\u0000"))
      .digest("hex")
      .slice(0, 16);
    return [
      { id, scope, a, b, signals: c.signals, graphConfidence: c.confidence },
    ];
  });
}
