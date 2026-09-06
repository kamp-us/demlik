import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("debounce — trailing (default)", () => {
  it("coalesces a rapid burst into one fire with the LAST args after ms", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("a");
    d("b");
    d("c");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
  });

  it("does not fire before ms elapses", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d(1);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("resets the timer on each call (sliding window)", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("x");
    vi.advanceTimersByTime(80);
    d("y"); // resets the 100ms window
    vi.advanceTimersByTime(80); // 160ms since first call, but only 80 since last
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20); // 100ms since the "y" call
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("y");
  });

  it("fires again for a second, separated burst", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("first");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("first");

    d("second");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("second");
  });
});

describe("debounce — cancel", () => {
  it("drops the pending fire without invoking fn", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("dropped");
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    expect(() => d.cancel()).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("debounce — flush", () => {
  it("fires the pending call immediately with its args", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("now");
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("now");
  });

  it("does not double-fire when the timer would later elapse", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d("once");
    d.flush();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);

    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("debounce — leading", () => {
  it("fires once on the FIRST call of a burst with the first args", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: false });

    d("first");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("first");

    // mid-burst calls are swallowed
    d("second");
    d("third");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    // a new burst after quiet leads again
    d("fourth");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("fourth");
  });

  it("leading + trailing fires at both edges for a multi-call burst", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: true });

    d("a"); // leading fire
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");

    d("b");
    d("c");
    vi.advanceTimersByTime(100); // trailing fire with last args
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("leading + trailing does NOT double-fire for a lone call", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: true, trailing: true });

    d("solo"); // leading fire only
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("solo");
  });
});

describe("debounce — degenerate", () => {
  it("never fires when both edges are disabled", () => {
    const fn = vi.fn();
    const d = debounce(fn, 100, { leading: false, trailing: false });

    d("nope");
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
