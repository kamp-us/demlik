// Runtime exercise of a MULTI-SITE guard: the same `worthRetrying` is reached
// from two edges, and the compiled cell must hand it the right `at` tag at each
// one — the tag the type system correlates on has to be the tag the walk passes.
import { expect, it } from "vitest";
import { applyCell, type Cmd } from "../pure/core";
import { type RG, type RState, retrier } from "./assert.test-d";
import type { MsgIn } from "./graph";

type M = MsgIn<RG, "r">;
const machine = { update: retrier as object, __form: "transitions" as const };
const step = (s: RState, m: M): RState =>
  applyCell<RState, M, Cmd<never>>(machine, s, m)[0];

/**
 * One assertion → one vitest test. Everything these files assert is computed at
 * module scope from pure data, so registering the case here (rather than
 * wrapping the whole file in one `it`) keeps a failure pointing at the single
 * claim that broke, exactly as the smoke script's per-line output did.
 *
 * The comparison is stable JSON rather than `toEqual`, which is what the script
 * compared — key order included.
 */
const eq = (label: string, got: unknown, want: unknown): void => {
  it(label, () => {
    expect(JSON.stringify(got), label).toBe(JSON.stringify(want));
  });
};

// site 1 — `fetching.TIMEOUT`. The guard reads `s.url` and `m.afterMs`.
eq(
  "fetching -TIMEOUT-> fetching (afterMs under budget)",
  step(
    { type: "fetching", attempt: 0, url: "u" },
    { type: "r.TIMEOUT", afterMs: 100 },
  ),
  { attempt: 1, url: "u", type: "fetching" },
);
eq(
  "fetching -TIMEOUT-> dead (afterMs over budget)",
  step(
    { type: "fetching", attempt: 0, url: "u" },
    { type: "r.TIMEOUT", afterMs: 60_000 },
  ).type,
  "dead",
);
eq(
  "fetching -TIMEOUT-> dead (attempts spent)",
  step(
    { type: "fetching", attempt: 3, url: "u" },
    { type: "r.TIMEOUT", afterMs: 1 },
  ).type,
  "dead",
);

// site 2 — `parsing.CORRUPT`. Same guard, and it must take the OTHER branch:
// it reads `s.bytes` and `m.offset`, neither of which exists at site 1.
eq(
  "parsing -CORRUPT-> fetching (bytes present)",
  step(
    { type: "parsing", attempt: 0, bytes: 10 },
    { type: "r.CORRUPT", offset: 4 },
  ),
  { attempt: 1, url: "refetch", type: "fetching" },
);
eq(
  "parsing -CORRUPT-> dead (empty body)",
  step(
    { type: "parsing", attempt: 0, bytes: 0 },
    { type: "r.CORRUPT", offset: 0 },
  ).type,
  "dead",
);
