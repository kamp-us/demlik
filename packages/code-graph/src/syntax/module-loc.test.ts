import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../test-helpers/ratchet-repo.js";

const SIZES = [1, 399, 400, 401, 2100];

const newlineEnded = (count: number): string =>
  Array.from({ length: count }, (_, i) => `export const v${i} = ${i};\n`).join("");

const fileOf = (size: number): string => `src/lines${size}.ts`;

const wcLines = (file: string): number =>
  Number.parseInt(execFileSync("wc", ["-l", file], { encoding: "utf8" }).trim(), 10);

type GraphModule = { file: string; loc: number; smells: { kind: string }[] };
type GraphOutput = { modules: GraphModule[]; stats: { totalLoc: number } };

let root: string;
let graph: GraphOutput;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-module-loc-")));
  fs.mkdirSync(path.join(root, "src"));
  for (const size of SIZES) fs.writeFileSync(path.join(root, fileOf(size)), newlineEnded(size));
  const run = runCli([root, "--graph"]);
  expect(run.code).toBe(0);
  graph = JSON.parse(run.stdout);
}, 60_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const moduleOf = (size: number): GraphModule => {
  const found = graph.modules.find((module) => module.file === fileOf(size));
  if (found === undefined) throw new Error(`${fileOf(size)} is not in the graph`);
  return found;
};

const hasBigFile = (module: GraphModule): boolean =>
  module.smells.some((smell) => smell.kind === "big-file");

describe("a module's loc is the number a person counts", () => {
  it.each(SIZES)("a file of %i newline-ended lines has the loc wc -l reports", (size) => {
    expect(wcLines(path.join(root, fileOf(size)))).toBe(size);
    expect(moduleOf(size).loc).toBe(size);
  });

  it("the total is the sum of those lines", () => {
    expect(graph.stats.totalLoc).toBe(SIZES.reduce((total, size) => total + size, 0));
  });

  it("big-file fires past the default limit of 400, not at it", () => {
    expect(hasBigFile(moduleOf(399))).toBe(false);
    expect(hasBigFile(moduleOf(400))).toBe(false);
    expect(hasBigFile(moduleOf(401))).toBe(true);
    expect(hasBigFile(moduleOf(2100))).toBe(true);
  });
});
