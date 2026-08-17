// Runtime exercise of a MULTI-SITE guard: the same `worthRetrying` is reached
// from two edges, and the compiled cell must hand it the right `at` tag at each
// one — the tag the type system correlates on has to be the tag the walk passes.
import { type Cmd, applyCell } from "../pure/core";
import { type RG, type RState, retrier } from "./assert";
import type { MsgIn } from "./graph";

type M = MsgIn<RG, "r">;
const machine = { update: retrier as object, __form: "transitions" as const };
const step = (s: RState, m: M): RState =>
  applyCell<RState, M, Cmd<never>>(machine, s, m)[0];

const eq = (label: string, got: unknown, want: unknown): void => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`${g === w ? "ok  " : "FAIL"} ${label}  got=${g} want=${w}`);
};

// site 1 — `fetching.TIMEOUT`. The guard reads `s.url` and `m.afterMs`.
eq(
  "fetching -TIMEOUT-> fetching (afterMs under budget)",
  step({ type: "fetching", attempt: 0, url: "u" }, { type: "r.TIMEOUT", afterMs: 100 }),
  { attempt: 1, url: "u", type: "fetching" },
);
eq(
  "fetching -TIMEOUT-> dead (afterMs over budget)",
  step({ type: "fetching", attempt: 0, url: "u" }, { type: "r.TIMEOUT", afterMs: 60_000 })
    .type,
  "dead",
);
eq(
  "fetching -TIMEOUT-> dead (attempts spent)",
  step({ type: "fetching", attempt: 3, url: "u" }, { type: "r.TIMEOUT", afterMs: 1 }).type,
  "dead",
);

// site 2 — `parsing.CORRUPT`. Same guard, and it must take the OTHER branch:
// it reads `s.bytes` and `m.offset`, neither of which exists at site 1.
eq(
  "parsing -CORRUPT-> fetching (bytes present)",
  step({ type: "parsing", attempt: 0, bytes: 10 }, { type: "r.CORRUPT", offset: 4 }),
  { attempt: 1, url: "refetch", type: "fetching" },
);
eq(
  "parsing -CORRUPT-> dead (empty body)",
  step({ type: "parsing", attempt: 0, bytes: 0 }, { type: "r.CORRUPT", offset: 0 }).type,
  "dead",
);
