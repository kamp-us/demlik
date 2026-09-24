import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleGraph } from "./extract/assemble.js";
import { isTestFile } from "./extract/functions.js";
import { loadCheapProject } from "./extract/project.js";
import { type Smell, type SmellTarget, type Thresholds, ThresholdsSchema } from "./schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = here;
const THRESHOLDS_FILE = path.resolve(here, "..", "selfcheck.thresholds.json");

function gateThresholds(): Thresholds {
  const defaults = ThresholdsSchema.parse({});
  const raw = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, "utf8"));
  const overrides = ThresholdsSchema.partial().parse(raw);
  return { ...defaults, ...overrides };
}

function targetFile(target: SmellTarget): string | null {
  switch (target.type) {
    case "function":
    case "module":
      return target.file;
    case "directory":
      return null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function isTestSmell(smell: Smell): boolean {
  const file = targetFile(smell.target);
  return file !== null && isTestFile(file);
}

function targetLabel(target: SmellTarget): string {
  switch (target.type) {
    case "function":
      return `${target.id} (${target.file}:${target.startLine})`;
    case "module":
      return target.file;
    case "directory":
      return target.dir;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

describe("self-gate — @demlik/code-graph passes its own smell checks (dogfooding)", () => {
  it("has zero structural smells on its own non-test src at the gate thresholds", () => {
    const thresholds = gateThresholds();
    const loaded = loadCheapProject(SRC_DIR);
    const graph = assembleGraph(loaded, thresholds);

    const offenders = graph.smells.filter((s) => !isTestSmell(s));

    const detail = offenders
      .map(
        (s) =>
          `  ${s.kind}: ${targetLabel(s.target)} — value ${s.value} > threshold ${s.threshold}`,
      )
      .join("\n");

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `code-graph flags its own non-test code (${offenders.length} smell(s)). ` +
            `Refactor under the gate thresholds, or justify a threshold bump in ` +
            `selfcheck.thresholds.json:\n${detail}`,
    ).toEqual([]);
  });
});
