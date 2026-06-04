import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeadlineExceeded,
  deadlineExceeded,
  deadlineSub,
  subscribeDeadline,
} from "./index";

// vi.useFakeTimers() mocks BOTH `setTimeout`/`clearTimeout` AND the `Date`
// global, so `Date.now()` reads the fake clock that `vi.setSystemTime` /
// `vi.advanceTimersByTime` drive. That lets us test the absolute-deadline
// arithmetic deterministically without injecting a clock — matching the
// no-injection convention of the fromTimeout / fromInterval exemplars.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// A base wall-clock instant so `atMs` targets are readable epoch numbers.
const BASE = 1_000_000;

describe("deadlineSub", () => {
  it("builds a stable, identity-branded Sub carrying the absolute target", () => {
    const sub = deadlineSub("audit-stale", BASE + 900_000);
    expect(sub.type).toBe("deadline");
    expect(sub.id).toBe("audit-stale");
    expect(sub.atMs).toBe(BASE + 900_000);
  });

  it("produces the same id across calls so the reconcile pass won't churn it", () => {
    // Two literals built at different moments for the same logical deadline
    // share an id — the substrate keys identity by id, so this is the
    // no-churn case (same id across transitions = same armed timer).
    vi.setSystemTime(BASE);
    const a = deadlineSub("guard", BASE + 1000);
    vi.setSystemTime(BASE + 500);
    const b = deadlineSub("guard", BASE + 1000);
    expect(a.id).toBe(b.id);
    expect(a.type).toBe(b.type);
  });
});

describe("subscribeDeadline", () => {
  it("fires once after exactly (atMs - now), dispatching deadlineExceeded", () => {
    vi.setSystemTime(BASE);
    const dispatched: DeadlineExceeded[] = [];
    const sub = deadlineSub("guard", BASE + 5000); // 5s from now

    subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

    // Just before the deadline: nothing yet.
    vi.advanceTimersByTime(4999);
    expect(dispatched).toEqual([]);

    // Cross the deadline.
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual([deadlineExceeded("guard", BASE + 5000)]);

    // One-shot: no re-fire after the target.
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toHaveLength(1);
  });

  it("does NOT fire before the deadline", () => {
    vi.setSystemTime(BASE);
    const dispatched: DeadlineExceeded[] = [];
    const sub = deadlineSub("guard", BASE + 1000);

    subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

    vi.advanceTimersByTime(999);
    expect(dispatched).toEqual([]);
  });

  it("cleanup cancels the pending timer — no dispatch after cleanup", () => {
    vi.setSystemTime(BASE);
    const dispatched: DeadlineExceeded[] = [];
    const sub = deadlineSub("guard", BASE + 5000);

    const cleanup = subscribeDeadline(sub, undefined, (m) =>
      dispatched.push(m),
    );
    // Disarm before the timer fires (the "cancel on state exit" path).
    cleanup();

    vi.advanceTimersByTime(10_000);
    expect(dispatched).toEqual([]);
  });

  it("a deadline already in the past fires on the NEXT tick, not synchronously", () => {
    vi.setSystemTime(BASE);
    const dispatched: DeadlineExceeded[] = [];
    // atMs is 1s in the PAST relative to `now` — simulates a late subscribe
    // after a rehydrate.
    const sub = deadlineSub("guard", BASE - 1000);

    subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

    // Synchronous: the reconcile pass must finish before any Msg lands.
    expect(dispatched).toEqual([]);

    // Next tick (delay 0) — now it fires, with the original past target echoed.
    vi.advanceTimersByTime(0);
    expect(dispatched).toEqual([deadlineExceeded("guard", BASE - 1000)]);
  });

  it("recomputes remaining delay from the current clock (late subscribe still hits the absolute target)", () => {
    // Deadline set against an early clock, but subscribed 3s later: the
    // remaining delay must be (atMs - now) = 2000, not the original 5000.
    const atMs = BASE + 5000;
    vi.setSystemTime(BASE + 3000);
    const dispatched: DeadlineExceeded[] = [];
    const sub = deadlineSub("guard", atMs);

    subscribeDeadline(sub, undefined, (m) => dispatched.push(m));

    vi.advanceTimersByTime(1999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual([deadlineExceeded("guard", atMs)]);
  });
});

describe("deadlineExceeded", () => {
  it("constructs the tagged Msg shape consumers union into their reducer", () => {
    expect(deadlineExceeded("guard", BASE + 5000)).toEqual({
      type: "deadline_exceeded",
      id: "guard",
      atMs: BASE + 5000,
    });
  });
});
