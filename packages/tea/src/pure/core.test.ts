import { describe, expect, it } from "vitest";
import { deepFreeze } from "./core";

describe("deepFreeze", () => {
  it("freezes every level of a fresh value", () => {
    const value = { run: { steps: [{ id: "a" }] } };
    deepFreeze(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.run)).toBe(true);
    expect(Object.isFrozen(value.run.steps)).toBe(true);
    expect(Object.isFrozen(value.run.steps[0])).toBe(true);
  });

  it("does not walk a value that is already frozen", () => {
    const kept = Object.freeze({ child: { open: true } });
    deepFreeze({ kept });
    expect(Object.isFrozen(kept.child)).toBe(false);
  });

  it("freezes the new parts of a state that holds an earlier frozen state", () => {
    const earlier = deepFreeze({ steps: [{ id: "a" }] });
    const next = { earlier, added: { id: "b" } };
    deepFreeze(next);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.added)).toBe(true);
    expect(next.earlier).toBe(earlier);
  });
});
