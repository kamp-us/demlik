import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatherSignals } from "../src/propose/signals.js";
import { repo } from "./helpers.js";

/** The argument list of every git subprocess spawned since the last reset. */
const spawned = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const record =
    <F extends (...args: never[]) => unknown>(spawn: F) =>
    (...args: Parameters<F>) => {
      const [command, list] = args as unknown as [string, string[]];
      if (command === "git") spawned.push([...list]);
      return spawn(...args);
    };
  return {
    ...real,
    execFileSync: record(real.execFileSync),
    spawnSync: record(real.spawnSync),
  };
});

const fixture = (files: number) =>
  repo(
    Object.fromEntries(
      Array.from({ length: files }, (_, n) => [
        `app/m${n}.ts`,
        `export const m${n} = ${n};`,
      ]),
    ),
  );

describe("propose's git reads", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it.each([2, 40])("reads %i swept files in one cat-file subprocess", (n) => {
    const root = fixture(n);
    spawned.length = 0;

    const signals = gatherSignals({
      root,
      ref: "HEAD",
      scopes: ["app"],
      depth: 3,
      graphs: [],
      blind: true,
    });

    expect(signals.content.files).toBe(n);
    // `--batch -z` needs git 2.38; plain `--batch` reads on any git propose otherwise runs on.
    expect(spawned.filter((args) => args[0] === "cat-file")).toEqual([
      ["cat-file", "--batch"],
    ]);
    expect(spawned.filter((args) => args[0] === "show")).toEqual([]);
  });
});
