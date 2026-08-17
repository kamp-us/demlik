import { describe, expect, it } from "vitest";
import { run } from "../../../src/index";
import { type Cell, cell, collect, memStore } from "../harness";
import {
  backoffMs,
  type Cmd,
  type DeviceConfig,
  fleetReconcileMachine,
  type Msg,
  parseState,
  REPORT_GRACE_MS,
  type State,
  sameConfig,
} from "./machine";

const DEVICE = "cam-0417";
const V1: DeviceConfig = { fps: 30, codec: "h265", nightMode: true };
const V2: DeviceConfig = { fps: 15, codec: "h265", nightMode: true };
const CMD_TYPES = ["push_config"] as const;

async function boot(c: Cell) {
  const sink = collect<Msg, Cmd, Record<string, never>>(CMD_TYPES);
  const rt = await run(fleetReconcileMachine(sink.interpret), {
    ctx: {},
    store: memStore<State>(c, parseState),
  }).ready;
  return { rt, cmds: sink.cmds };
}

describe("fleet reconcile — the loop", () => {
  it("pushes on divergence and converges when the device agrees", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 0,
    });
    expect(rt.getState().phase).toBe("pushing");
    expect(cmds).toEqual([
      { type: "push_config", deviceId: DEVICE, config: V1, rev: 1 },
    ]);

    await rt.dispatch({ type: "push_ok", rev: 1, at: 100 });
    expect(rt.getState().phase).toBe("awaiting-report");
    expect(rt.getState().dueAt).toBe(100 + REPORT_GRACE_MS);

    await rt.dispatch({ type: "reported", config: V1, at: 200 });
    const converged = rt.getState();
    expect(converged.phase).toBe("converged");
    expect(converged.dueAt).toBeNull();
    expect(converged.attempt).toBe(0);
    // No further pushes: converged means the loop stops issuing work.
    expect(cmds).toHaveLength(1);

    await rt.stop();
  });

  it("does nothing when the device already reports the desired config", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({ type: "reported", config: V1, at: 0 });
    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 10,
    });

    expect(rt.getState().phase).toBe("converged");
    expect(cmds).toHaveLength(0);

    await rt.stop();
  });

  it("backs off on repeated push failure and re-pushes when the alarm comes due", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 0,
    });

    await rt.dispatch({
      type: "push_failed",
      rev: 1,
      reason: "device offline",
      at: 1_000,
    });
    expect(rt.getState().phase).toBe("backoff");
    expect(rt.getState().attempt).toBe(1);
    expect(rt.getState().dueAt).toBe(1_000 + backoffMs(1));
    expect(rt.getState().lastError).toBe("device offline");

    await rt.dispatch({ type: "tick", at: 1_000 + backoffMs(1) });
    expect(rt.getState().phase).toBe("pushing");
    expect(cmds).toHaveLength(2);
    // The attempt count carried across the retry, so the curve keeps climbing.
    await rt.dispatch({
      type: "push_failed",
      rev: 1,
      reason: "device offline",
      at: 50_000,
    });
    expect(rt.getState().attempt).toBe(2);
    expect(rt.getState().dueAt).toBe(50_000 + backoffMs(2));
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));

    await rt.stop();
  });

  it("treats device silence as a lost push", async () => {
    const c = cell();
    const { rt } = await boot(c);

    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 0,
    });
    await rt.dispatch({ type: "push_ok", rev: 1, at: 0 });
    expect(rt.getState().phase).toBe("awaiting-report");

    await rt.dispatch({ type: "tick", at: REPORT_GRACE_MS });
    expect(rt.getState().phase).toBe("backoff");
    expect(rt.getState().lastError).toBe("device did not report back");

    await rt.stop();
  });

  it("discards a stale outcome when the target moved mid-push", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 0,
    });
    // The operator changes their mind while rev 1 is in the air.
    await rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V2,
      at: 10,
    });
    expect(rt.getState().desiredRev).toBe(2);
    expect(cmds.at(-1)).toEqual({
      type: "push_config",
      deviceId: DEVICE,
      config: V2,
      rev: 2,
    });

    // Rev 1's success lands late. Converging on it would strand the device on a
    // config nobody wants.
    await rt.dispatch({ type: "push_ok", rev: 1, at: 20 });
    expect(rt.getState().phase).toBe("pushing");
    expect(rt.getState().inFlightRev).toBe(2);

    await rt.dispatch({ type: "push_ok", rev: 2, at: 30 });
    await rt.dispatch({ type: "reported", config: V2, at: 40 });
    expect(rt.getState().phase).toBe("converged");

    await rt.stop();
  });

  it("compares configs by value", () => {
    expect(sameConfig(V1, { ...V1 })).toBe(true);
    expect(sameConfig(V1, V2)).toBe(false);
    expect(sameConfig(V1, null)).toBe(false);
    expect(sameConfig(V1, { fps: 30, codec: "h265" })).toBe(false);
  });
});

describe("fleet reconcile — resume from serialized state", () => {
  it("resumes mid-backoff on a fresh runtime and finishes the loop", async () => {
    const c = cell();
    const first = await boot(c);

    await first.rt.dispatch({
      type: "set_desired",
      deviceId: DEVICE,
      config: V1,
      at: 0,
    });
    await first.rt.dispatch({
      type: "push_failed",
      rev: 1,
      reason: "device offline",
      at: 1_000,
    });
    await first.rt.dispatch({ type: "tick", at: 1_000 + backoffMs(1) });
    await first.rt.dispatch({
      type: "push_failed",
      rev: 1,
      reason: "device offline",
      at: 40_000,
    });
    const owedAt = first.rt.getState().dueAt as number;
    expect(first.rt.getState().phase).toBe("backoff");
    expect(first.rt.getState().attempt).toBe(2);
    await first.rt.stop();

    const parsed = parseState(JSON.parse(c.raw as string));
    expect(parsed?.phase).toBe("backoff");
    expect(parsed?.attempt).toBe(2);

    const second = await boot(c);
    const resumed = second.rt.getState();
    // The loop is re-entrant from state alone: rev, attempt and deadline all
    // survived, so the fresh runtime owes exactly what the dead one owed.
    expect(resumed.desiredRev).toBe(1);
    expect(resumed.attempt).toBe(2);
    expect(resumed.dueAt).toBe(owedAt);

    await second.rt.dispatch({ type: "tick", at: owedAt });
    expect(second.cmds).toEqual([
      { type: "push_config", deviceId: DEVICE, config: V1, rev: 1 },
    ]);

    await second.rt.dispatch({ type: "push_ok", rev: 1, at: owedAt + 10 });
    await second.rt.dispatch({ type: "reported", config: V1, at: owedAt + 20 });
    expect(second.rt.getState().phase).toBe("converged");
    expect(second.rt.getState().attempt).toBe(0);

    await second.rt.stop();
  });
});
