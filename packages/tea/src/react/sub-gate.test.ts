import { describe, expect, it, vi } from "vitest";
import { SubGate } from "./sub-gate";

describe("SubGate", () => {
  it("starts nothing while closed, and everything once when it opens", () => {
    const gate = new SubGate();
    const begin = vi.fn(() => () => {});
    gate.admit(begin);
    expect(begin).not.toHaveBeenCalled();

    gate.open();
    gate.open();
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("starts a Sub at once when open, and lets its throw reach the caller", () => {
    const gate = new SubGate();
    gate.open();
    expect(() =>
      gate.admit(() => {
        throw new Error("no source");
      }),
    ).toThrow("no source");
  });

  it("runs one Sub's cleanup once however it is closed", () => {
    const gate = new SubGate();
    const dispose = vi.fn();
    gate.open();
    const release = gate.admit(() => dispose);

    gate.close();
    gate.close();
    release();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not start a Sub the engine has already released", () => {
    const gate = new SubGate();
    const begin = vi.fn(() => () => {});
    const release = gate.admit(begin);
    release();

    gate.open();
    expect(begin).not.toHaveBeenCalled();
  });

  it("hands the engine a cleanup still settling from the hide, so `stop()` waits for it", async () => {
    const gate = new SubGate();
    let settle = (): void => {};
    const settling = new Promise<void>((resolve) => {
      settle = resolve;
    });
    gate.open();
    const release = gate.admit(() => () => settling);

    gate.close();
    let waited = false;
    const stopping = Promise.resolve(release()).then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);

    settle();
    await stopping;
    expect(waited).toBe(true);
  });

  it("raises an async cleanup's rejection at a hide once, and `stop()` does not see it again", async () => {
    const raise = vi.fn();
    const gate = new SubGate(raise);
    const bad = new Error("cleanup bad");
    gate.open();
    const release = gate.admit(() => () => Promise.reject(bad));

    gate.close();
    gate.close();
    await expect(release()).resolves.toBeUndefined();

    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith(bad);
  });

  it("starts every Sub though one throws, then throws the first error", () => {
    const gate = new SubGate();
    const after = vi.fn(() => () => {});
    gate.admit(() => {
      throw new Error("first");
    });
    gate.admit(() => {
      throw new Error("second");
    });
    gate.admit(after);

    expect(() => gate.open()).toThrow("first");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("cleans up every Sub though one throws, then throws the first error", () => {
    const gate = new SubGate();
    const after = vi.fn();
    gate.open();
    gate.admit(() => () => {
      throw new Error("first");
    });
    gate.admit(() => after);

    expect(() => gate.close()).toThrow("first");
    expect(after).toHaveBeenCalledTimes(1);
  });
});
