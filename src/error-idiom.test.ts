import { describe, expect, it } from "vitest";
import type { UnauthorizedError } from "./authed-call";
import { TerminalTimeoutError } from "./await-terminal";
import {
  NoCellError,
  PortNameCollisionError,
  QuiescenceTimeoutError,
} from "./index";
import type { DeadlineExceededError } from "./resilient-call";
import { RetryExhaustedError } from "./retry-to-success";

// ───────────────────────────────────────────────────────────────────────────
// #283 — one error idiom PER KIND, and the conformance guard that pins it.
//
// The package has TWO legitimately different kinds of first-class error, and
// they converge on ONE idiom EACH — both `_tag`-switchable, split only on
// whether `instanceof` is available:
//
//   (1) THROWN / boundary errors — raised at the runtime edge, never folded
//       into Model. `class extends Error` + `readonly _tag` literal, so a
//       consumer can branch by `instanceof` OR by tag.
//       → PortNameCollisionError, QuiescenceTimeoutError, NoCellError,
//         TerminalTimeoutError, RetryExhaustedError.
//
//   (2) SETTLED-VALUE errors — folded INTO a machine's Model (`call.error`,
//       `settleFailed`) and persisted into a `Store<S>` that reloads via plain
//       `JSON.parse`. A `{_tag, ...}` sentinel, NEVER a `new Error`: a class
//       instance loses its prototype on reload (so `instanceof` is worthless
//       exactly where these live) and a bare Error round-trips to `{}`. The
//       value MUST stay round-trip-equal under JSON — the Model durability
//       invariant. So it is `_tag`-switchable only, by construction.
//       → DeadlineExceededError, UnauthorizedError.
//
// This file is the single conformance guard: every public error is asserted
// against its kind's idiom so the two kinds cannot silently drift back apart.
// ───────────────────────────────────────────────────────────────────────────

type ThrownCase = {
  readonly name: string;
  readonly make: () => Error & { readonly _tag: string };
  readonly ctor: new (...args: never[]) => Error;
  readonly tag: string;
};

// One row per THROWN error. `make` constructs a real instance so the assertion
// exercises the class, not a mock.
const thrownCases: readonly ThrownCase[] = [
  {
    name: "PortNameCollisionError",
    make: () => new PortNameCollisionError("dup-port"),
    ctor: PortNameCollisionError,
    tag: "PortNameCollisionError",
  },
  {
    name: "QuiescenceTimeoutError",
    make: () => new QuiescenceTimeoutError(25),
    ctor: QuiescenceTimeoutError,
    tag: "QuiescenceTimeoutError",
  },
  {
    name: "NoCellError",
    make: () => new NoCellError("unknown_msg", "SomeState"),
    ctor: NoCellError,
    tag: "NoCellError",
  },
  {
    name: "TerminalTimeoutError",
    make: () => new TerminalTimeoutError(100),
    ctor: TerminalTimeoutError,
    tag: "TerminalTimeoutError",
  },
  {
    name: "RetryExhaustedError",
    make: () => new RetryExhaustedError(3, new Error("final attempt")),
    ctor: RetryExhaustedError,
    tag: "RetryExhaustedError",
  },
];

type SettledCase = {
  readonly name: string;
  readonly value: { readonly _tag: string };
  readonly tag: string;
};

// One row per SETTLED-VALUE error. `satisfies` pins each literal to the real
// public type, so a drift in the type breaks this test rather than the wire.
const settledCases: readonly SettledCase[] = [
  {
    name: "DeadlineExceededError",
    value: {
      _tag: "deadline_exceeded",
      id: "resilient:deadline:k",
      atMs: 1,
    } satisfies DeadlineExceededError,
    tag: "deadline_exceeded",
  },
  {
    name: "UnauthorizedError",
    value: { _tag: "unauthorized", key: "k" } satisfies UnauthorizedError,
    tag: "unauthorized",
  },
];

describe("error idiom conformance (#283)", () => {
  describe("thrown errors — class extends Error + readonly _tag (instanceof AND tag)", () => {
    for (const c of thrownCases) {
      it(`${c.name}: instanceof Error, instanceof ${c.name}, and _tag === name === "${c.name}"`, () => {
        const err = c.make();
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(c.ctor);
        expect(err._tag).toBe(c.tag);
        // The `_tag` literal and the `override readonly name` agree — one noun.
        expect(err.name).toBe(c.tag);
      });
    }
  });

  describe("settled-value errors — plain {_tag} sentinel, tag-switchable, serializable", () => {
    for (const c of settledCases) {
      it(`${c.name}: is a plain tag-switchable sentinel, NOT an Error`, () => {
        expect(c.value).not.toBeInstanceOf(Error);
        expect(c.value._tag).toBe(c.tag);
      });

      it(`${c.name}: is JSON round-trip-equal (Model durability invariant)`, () => {
        // The exact reload path a `Store<S>` takes: JSON out, JSON back in.
        const reloaded: unknown = JSON.parse(JSON.stringify(c.value));
        expect(reloaded).toEqual(c.value);
      });
    }
  });

  it("a class error loses instanceof after a JSON round-trip — why Model-resident value errors stay plain sentinels", () => {
    const live = new TerminalTimeoutError(1);
    expect(live).toBeInstanceOf(TerminalTimeoutError);

    // Persist-and-reload strips the prototype: `instanceof` is worthless for a
    // value that lives in Model, which is exactly why (2) never uses a class.
    const reloaded: unknown = JSON.parse(JSON.stringify(live));
    expect(reloaded).not.toBeInstanceOf(TerminalTimeoutError);
  });
});
