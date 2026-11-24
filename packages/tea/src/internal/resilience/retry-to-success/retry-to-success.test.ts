import { describe, expect, it, vi } from "vitest";
import {
  asRng,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  recordFailure,
} from "../../../retry-backoff";
import { RetryExhaustedError, retryToSuccess } from "./index";

// ===========================================================================
// A bounded policy with FULL jitter and a pinned rng, so the backoff schedule
// is deterministic: `nextDelayMs` under `rng() = 0.5` is exactly `0.5 * d`. The
// test never touches wall-clock time — `sleep` is a spy that resolves instantly
// and records the delays it was handed, so the schedule the loop drives is
// directly observable.
// ===========================================================================

const policy: RetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 3,
  jitter: "full",
};

// Pin jitter to the midpoint so every delay is reproducible. Branded via asRng
// (the module's only entry for randomness) — a raw `() => 0.5` would not type.
const rng = asRng(() => 0.5);

// A sleep spy: records each delay, resolves immediately (no real timer).
function recordingSleep() {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { delays, sleep };
}

// The backoff schedule `retryToSuccess` MUST drive for `n` failures, computed
// from the same `./retry-backoff` primitives the helper uses — so the test
// asserts "reuses retry-backoff", not a hand-copied number. One delay per
// retry (a success/give-up after failure `k` has waited before attempts 1..k).
function expectedDelays(failures: number): number[] {
  const out: number[] = [];
  let retry = initRetry();
  for (let i = 0; i < failures; i += 1) {
    retry = recordFailure(retry, new Error("boom"));
    out.push(nextDelayMs(retry, policy, rng));
  }
  return out;
}

describe("retryToSuccess", () => {
  it("resolves with the port value on the first success — no sleep, no retry", async () => {
    const { delays, sleep } = recordingSleep();
    const port = vi.fn(async () => "ok");

    await expect(retryToSuccess(port, policy, { rng, sleep })).resolves.toBe(
      "ok",
    );

    expect(port).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]); // never backed off
  });

  it("retries a transient failure and resolves once the port succeeds", async () => {
    const { delays, sleep } = recordingSleep();
    // Throw twice, then succeed on the third invocation (within maxAttempts=3).
    let calls = 0;
    const port = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`transient ${calls}`);
      return calls;
    });

    await expect(retryToSuccess(port, policy, { rng, sleep })).resolves.toBe(3);

    expect(port).toHaveBeenCalledTimes(3);
    // Two failures → two backoff waits, on the exact retry-backoff schedule.
    expect(delays).toEqual(expectedDelays(2));
  });

  it("drives the FULL bounded-retry path to terminal give-up and rejects (never swallows)", async () => {
    const { delays, sleep } = recordingSleep();
    const final = new Error("still failing");
    let calls = 0;
    // Always throws — the exhaustion path. The final throw is `final`, which the
    // rejection must carry, proving the error is surfaced, not swallowed.
    const port = vi.fn(async () => {
      calls += 1;
      throw calls < policy.maxAttempts ? new Error(`fail ${calls}`) : final;
    });

    const rejection = await retryToSuccess(port, policy, {
      rng,
      sleep,
    }).then(
      () => {
        throw new Error("expected retryToSuccess to reject at the bound");
      },
      (err: unknown) => err,
    );

    // Terminal give-up is a distinct, checkable rejection — instanceof AND tag.
    expect(rejection).toBeInstanceOf(RetryExhaustedError);
    const exhausted = rejection as RetryExhaustedError;
    expect(exhausted._tag).toBe("RetryExhaustedError");
    // The bound is honored exactly: the port ran maxAttempts times, no more.
    expect(port).toHaveBeenCalledTimes(policy.maxAttempts);
    expect(exhausted.attempts).toBe(policy.maxAttempts);
    // The final failure is carried, not lost.
    expect(exhausted.lastError).toBe(final);
    // One backoff wait per non-terminal failure (maxAttempts - 1), increasing.
    expect(delays).toEqual(expectedDelays(policy.maxAttempts - 1));
    expect(delays.length).toBe(policy.maxAttempts - 1);
  });

  it("honors a maxAttempts:1 policy as a single attempt with no retry", async () => {
    const { delays, sleep } = recordingSleep();
    const once: RetryPolicy = { ...policy, maxAttempts: 1 };
    const port = vi.fn(async () => {
      throw new Error("nope");
    });

    await expect(
      retryToSuccess(port, once, { rng, sleep }),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    // maxAttempts:1 → the first failure is already terminal: one call, no wait.
    expect(port).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("rejects with the failure itself, at once, when `retryable` refuses it", async () => {
    const { delays, sleep } = recordingSleep();
    const fatal = new Error("401");
    const port = vi.fn(async () => {
      throw fatal;
    });

    await expect(
      retryToSuccess(port, policy, { rng, sleep, retryable: () => false }),
    ).rejects.toBe(fatal);
    expect(port).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries the failures `retryable` allows, then rejects with the one it refuses", async () => {
    const { delays, sleep } = recordingSleep();
    const fatal = new Error("401");
    const failures = [new Error("a"), new Error("b"), fatal];
    const port = vi.fn(async () => {
      throw failures.shift();
    });

    await expect(
      retryToSuccess(port, policy, {
        rng,
        sleep,
        retryable: (error) => error !== fatal,
      }),
    ).rejects.toBe(fatal);
    expect(port).toHaveBeenCalledTimes(3);
    expect(delays).toEqual(expectedDelays(2));
  });

  describe("accept", () => {
    type Reply = { readonly ok: boolean; readonly n: number };

    it("retries refused values on the backoff ladder and resolves the accepted one", async () => {
      const { delays, sleep } = recordingSleep();
      let calls = 0;
      const port = vi.fn(async (): Promise<Reply> => {
        calls += 1;
        return { ok: calls >= 3, n: calls };
      });

      await expect(
        retryToSuccess(port, policy, { rng, sleep, accept: (v) => v.ok }),
      ).resolves.toEqual({ ok: true, n: 3 });
      expect(port).toHaveBeenCalledTimes(3);
      expect(delays).toEqual(expectedDelays(2));
    });

    it("rejects with RetryExhaustedError carrying the last refused value", async () => {
      const { delays, sleep } = recordingSleep();
      const seen: Reply[] = [];
      const port = vi.fn(async (): Promise<Reply> => {
        const reply = { ok: false, n: seen.length + 1 };
        seen.push(reply);
        return reply;
      });

      const rejection = await retryToSuccess(port, policy, {
        rng,
        sleep,
        accept: (v) => v.ok,
      }).then(
        () => {
          throw new Error("expected retryToSuccess to reject at the bound");
        },
        (err: unknown) => err,
      );

      expect(rejection).toBeInstanceOf(RetryExhaustedError);
      const exhausted = rejection as RetryExhaustedError;
      expect(exhausted.attempts).toBe(policy.maxAttempts);
      expect(port).toHaveBeenCalledTimes(policy.maxAttempts);
      expect(exhausted.lastError).toBe(seen[seen.length - 1]);
      expect(exhausted.lastError).toEqual({ ok: false, n: policy.maxAttempts });
      expect(delays).toEqual(expectedDelays(policy.maxAttempts - 1));
    });

    it("rethrows a throw `retryable` refuses at once, even with `accept` set", async () => {
      const { delays, sleep } = recordingSleep();
      const fatal = new Error("401");
      const accept = vi.fn((v: Reply) => v.ok);
      const port = vi.fn(async (): Promise<Reply> => {
        throw fatal;
      });

      await expect(
        retryToSuccess(port, policy, {
          rng,
          sleep,
          accept,
          retryable: () => false,
        }),
      ).rejects.toBe(fatal);
      expect(port).toHaveBeenCalledTimes(1);
      expect(accept).not.toHaveBeenCalled();
      expect(delays).toEqual([]);
    });

    it("counts a refused value and a retryable throw against one budget", async () => {
      const { delays, sleep } = recordingSleep();
      const retryable = vi.fn(() => true);
      const steps: Array<() => Reply> = [
        () => ({ ok: false, n: 1 }),
        () => {
          throw new Error("transient");
        },
        () => ({ ok: true, n: 3 }),
      ];
      const port = vi.fn(async (): Promise<Reply> => {
        const step = steps.shift();
        if (step === undefined) throw new Error("port called too often");
        return step();
      });

      await expect(
        retryToSuccess(port, policy, {
          rng,
          sleep,
          retryable,
          accept: (v) => v.ok,
        }),
      ).resolves.toEqual({ ok: true, n: 3 });
      expect(port).toHaveBeenCalledTimes(3);
      expect(retryable).toHaveBeenCalledTimes(1);
      expect(delays).toEqual(expectedDelays(2));

      const tight: RetryPolicy = { ...policy, maxAttempts: 2 };
      const again: Array<() => Reply> = [
        () => ({ ok: false, n: 1 }),
        () => {
          throw new Error("transient");
        },
        () => ({ ok: true, n: 3 }),
      ];
      await expect(
        retryToSuccess(
          async (): Promise<Reply> => {
            const step = again.shift();
            if (step === undefined) throw new Error("port called too often");
            return step();
          },
          tight,
          { rng, sleep: async () => {}, accept: (v) => v.ok },
        ),
      ).rejects.toBeInstanceOf(RetryExhaustedError);
    });

    it("rejects with the throw of `accept` on the first call, with no sleep", async () => {
      const { delays, sleep } = recordingSleep();
      const broken = new Error("accept broke");
      const retryable = vi.fn(() => true);
      const port = vi.fn(async (): Promise<Reply> => ({ ok: false, n: 1 }));

      await expect(
        retryToSuccess(port, policy, {
          rng,
          sleep,
          retryable,
          accept: () => {
            throw broken;
          },
        }),
      ).rejects.toBe(broken);
      expect(port).toHaveBeenCalledTimes(1);
      expect(retryable).not.toHaveBeenCalled();
      expect(delays).toEqual([]);
    });

    it("returns any resolved value at once when `accept` is left out", async () => {
      const { delays, sleep } = recordingSleep();
      const refused = { ok: false, n: 1 };
      const port = vi.fn(async (): Promise<Reply> => refused);

      await expect(retryToSuccess(port, policy, { rng, sleep })).resolves.toBe(
        refused,
      );
      expect(port).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });
  });
});
