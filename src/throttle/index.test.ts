import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("throttle — leading + trailing (default)", () => {
  it("fires immediately on the first call (leading)", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("drops calls within the window from immediate firing", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire
    t("b"); // dropped (queued for trailing)
    t("c"); // dropped (overwrites trailing candidate)
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");
  });

  it("fires once at window end with the LATEST dropped args (trailing)", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire
    t("b");
    t("c"); // latest dropped
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("does NOT trailing-fire when no extra call arrived during the window", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("solo"); // leading fire only
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("solo");
  });

  it("fires each call when spacing is >= ms", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a");
    vi.advanceTimersByTime(100);
    t("b");
    vi.advanceTimersByTime(100);
    t("c");
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "b");
    expect(fn).toHaveBeenNthCalledWith(3, "c");
  });

  it("caps a sustained burst to one fire per window", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    // Drive a call every 25ms for 250ms (11 calls).
    for (let i = 0; i <= 10; i++) {
      t(i);
      if (i < 10) vi.advanceTimersByTime(25);
    }
    // Leading fire (i=0) + a trailing fire at each 100ms window edge.
    // 250ms of activity → leading at t=0, trailing at t=100, t=200.
    vi.advanceTimersByTime(100); // flush the final window
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fn.mock.calls.length).toBeLessThanOrEqual(4);
    // Leading fire carried the first call's args.
    expect(fn).toHaveBeenNthCalledWith(1, 0);
    // The last fire carried the most recent args seen.
    expect(fn).toHaveBeenLastCalledWith(10);
  });
});

describe("throttle — cancel", () => {
  it("drops the pending trailing fire without invoking fn", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire
    t("b"); // queued trailing
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1); // only the leading fire ran
    expect(fn).toHaveBeenLastCalledWith("a");
  });

  it("resets the window so the next call leads immediately", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire, window open
    t.cancel();
    t("b"); // window was reset → leads immediately
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });

  it("is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    expect(() => t.cancel()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("throttle — flush", () => {
  it("fires the pending trailing call immediately with its latest args", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire
    t("b");
    t("c"); // latest pending
    t.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("does not double-fire when the window would later elapse", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a");
    t("b");
    t.flush();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);

    t("a"); // leading fire, no trailing pending
    t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("throttle — leading: false", () => {
  it("does not fire immediately; fires at window end with latest args", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100, { leading: false, trailing: true });

    t("a");
    t("b");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");
  });
});

describe("throttle — trailing: false", () => {
  it("fires only the leading edge and drops the rest", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100, { leading: true, trailing: false });

    t("a"); // leading fire
    t("b"); // dropped
    t("c"); // dropped
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });
});

describe("throttle — degenerate", () => {
  it("never fires when both edges are disabled", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100, { leading: false, trailing: false });

    t("nope");
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
