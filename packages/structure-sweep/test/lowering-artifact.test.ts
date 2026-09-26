import { describe, expect, it } from "vitest";
import {
  artifactKey,
  canonicalJson,
  contentHash,
  memoryArtifactStore,
  runStage,
  type Stage,
  type StageArtifact,
} from "../src/lowering/artifact.js";
import {
  derived,
  type Fact,
  type FactValue,
  sourceSpan,
  unknownValue,
} from "../src/lowering/fact.js";

/** A stage that counts its runs and writes one fact per non-empty input line. */
function lineStage(version: string): Stage<string> & { runs: number } {
  const stage = {
    name: "lines",
    version,
    runs: 0,
    run: async ({ content }: { readonly content: string }) => {
      stage.runs += 1;
      return content
        .split("\n")
        .map((line, n) => ({ line, n }))
        .filter(({ line }) => line !== "")
        .map(
          ({ line, n }): Fact<string> => ({
            id: `line-${n + 1}`,
            span: sourceSpan("input.txt", n + 1),
            value: derived(line),
          }),
        );
    },
  };
  return stage;
}

async function upstream(content: string): Promise<StageArtifact<unknown>> {
  const run = await runStage(memoryArtifactStore(), lineStage("1"), {
    content,
    artifacts: [],
  });
  return run.artifact;
}

describe("stage artifacts", () => {
  it("hits the store on an unchanged key without running the stage again", async () => {
    const store = memoryArtifactStore<string>();
    const stage = lineStage("1");
    const input = { content: "a\nb", artifacts: [await upstream("x")] };
    const first = await runStage(store, stage, input);
    const second = await runStage(store, stage, input);
    expect(first._tag).toBe("computed");
    expect(second._tag).toBe("hit");
    expect(second.artifact).toBe(first.artifact);
    expect(stage.runs).toBe(1);
  });

  it("recomputes when any one of input content, stage version or an input artifact changes", async () => {
    const store = memoryArtifactStore<string>();
    const x = await upstream("x");
    const base = { content: "a\nb", artifacts: [x] };
    const v1 = lineStage("1");
    const v2 = lineStage("2");
    await runStage(store, v1, base);

    const content = await runStage(store, v1, { ...base, content: "a\nc" });
    const version = await runStage(store, v2, base);
    const input = await runStage(store, v1, {
      ...base,
      artifacts: [await upstream("y")],
    });

    expect([content._tag, version._tag, input._tag]).toEqual([
      "computed",
      "computed",
      "computed",
    ]);
    expect(v1.runs).toBe(3);
    expect(v2.runs).toBe(1);
    const keys = new Set(
      [content, version, input].map((run) => run.artifact.key),
    );
    expect(keys.size).toBe(3);
  });

  it("derives the key from the stage, its version, the input hash and the input digests", async () => {
    const x = await upstream("x");
    const run = await runStage(memoryArtifactStore<string>(), lineStage("1"), {
      content: "a",
      artifacts: [x],
    });
    expect(run.artifact.key).toBe(
      artifactKey({
        stage: "lines",
        version: "1",
        inputHash: contentHash("a"),
        inputArtifacts: [x.digest],
      }),
    );
    expect(run.artifact.facts).toEqual([
      {
        id: "line-1",
        span: { file: "input.txt", startLine: 1, endLine: 1 },
        value: { _tag: "known", value: "a", basis: { _tag: "derived" } },
      },
    ]);
  });

  it("hashes objects the same whatever order their keys were written in", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe("facts", () => {
  it("refuses a span that points at no source", () => {
    expect(() => sourceSpan("a.ts", 0)).toThrow(RangeError);
    expect(() => sourceSpan("a.ts", 5, 4)).toThrow(RangeError);
    expect(() => sourceSpan("", 1)).toThrow(RangeError);
  });

  it("has no arm for a guessed value", () => {
    const values: FactValue<"gate">[] = [
      derived("gate"),
      unknownValue("abstained"),
      // @ts-expect-error a guess is not a fact value: there is no third arm
      { _tag: "guess", value: "gate", confidence: 0.4 },
      // @ts-expect-error an unknown value carries no answer a reader could mistake for one
      { _tag: "unknown", reason: "abstained", value: "gate" },
      // @ts-expect-error a known value states why it is known
      { _tag: "known", value: "gate" },
    ];
    expect(values).toHaveLength(5);
  });
});
