// The old port family is gone from every door (#664, ADR 0026). The word
// "port" is being freed for the typed ports that replace it, so the removal is
// pinned on the published surface itself: every subpath in `package.json`'s
// `exports` is opened, and none of them exports any of the family's names, as a
// value or as a type. The family's three members that were never exports, the
// handle's `subscribePort` / `emitPort` and the handler ctx's `emit`, are
// pinned on a live run of each engine: the Promise engine here, the Effect
// engine in `effect/old-port-family.test.ts`. That `ctx.emit` does not compile
// is `__tests__/undefined-ctx-handler.test-d.ts`.

import { join } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { PKG_ROOT, readApiMap } from "./api-ratchet/api-map";
import { defineMachine, type Interpret } from "./index";
import { run } from "./promise";

/** The seven names issue #664 removes. `ctx.emit` is the key `emit` on a handler's ctx. */
const REMOVED_EXPORTS = [
  "definePort",
  "fromPort",
  "subscribePort",
  "emitPort",
  "Port",
  "PortEmitter",
  "emit",
] as const;

const REMOVED_HANDLE_MEMBERS = ["subscribePort", "emitPort"] as const;

describe(
  "the old port family is exported from no door",
  { timeout: 30_000 },
  () => {
    /** Subpath → every name it exports, types included. */
    const published = new Map<string, ReadonlySet<string>>();

    beforeAll(async () => {
      const map = await readApiMap();
      const entries = Object.entries(map).map(
        ([subpath, { entry }]) => [subpath, join(PKG_ROOT, entry)] as const,
      );
      const config = ts.getParsedCommandLineOfConfigFile(
        join(PKG_ROOT, "tsconfig.json"),
        { noEmit: true },
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
      );
      if (config === undefined) throw new Error("tsconfig.json is unreadable");
      const program = ts.createProgram(
        entries.map(([, file]) => file),
        config.options,
      );
      const checker = program.getTypeChecker();
      for (const [subpath, file] of entries) {
        const source = program.getSourceFile(file);
        const symbol = source && checker.getSymbolAtLocation(source);
        if (symbol === undefined) {
          throw new Error(`${subpath}: ${file} is not a module tsc can open`);
        }
        published.set(
          subpath,
          new Set(checker.getExportsOfModule(symbol).map((s) => s.name)),
        );
      }
    }, 30_000);

    it("opens every subpath the export map publishes", async () => {
      const pkg = (await import("../package.json", { with: { type: "json" } }))
        .default as { exports: Readonly<Record<string, unknown>> };
      const doors = Object.keys(pkg.exports).filter(
        (subpath) => subpath !== "./package.json" && !subpath.endsWith(".css"),
      );
      expect(doors.length).toBeGreaterThan(20);
      expect([...published.keys()].sort()).toEqual([...doors].sort());
      // A door read as empty would pass the next test having checked nothing.
      for (const [subpath, names] of published) {
        expect(names.size, `${subpath} exports nothing`).toBeGreaterThan(0);
      }
      expect(published.get(".")?.has("defineMachine")).toBe(true);
      expect(published.get(".")?.has("Machine")).toBe(true);
    });

    it("finds none of the seven names on any of them", () => {
      const found = [...published].flatMap(([subpath, names]) =>
        REMOVED_EXPORTS.filter((name) => names.has(name)).map(
          (name) => `${subpath}: ${name}`,
        ),
      );
      expect(found).toEqual([]);
    });
  },
);

describe("a Promise run carries no member of the old port family", () => {
  type Msg = { readonly type: "go" };
  type Ping = { readonly type: "ping" };

  const machine = defineMachine({
    types: {
      model: {} as { readonly n: number },
      msg: {} as Msg,
      cmd: {} as Ping,
      ctx: {} as { readonly tag: string },
    },
    init: () => [{ n: 0 }, []],
    update: { go: (s) => [{ n: s.n + 1 }, [{ type: "ping" }]] },
  });

  /** A Cmd table that records the keys of the ctx its handler was handed. */
  function recording(): {
    readonly keys: string[][];
    readonly interpret: Interpret<Msg, Ping, { readonly tag: string }>;
  } {
    const keys: string[][] = [];
    return {
      keys,
      interpret: {
        ping: async (_cmd, ctx) => {
          keys.push(Object.keys(ctx));
        },
      },
    };
  }

  it("on its handle or its handler ctx", async () => {
    const { keys, interpret } = recording();
    const booting = run(machine, { ctx: { tag: "t" }, interpret });
    for (const member of REMOVED_HANDLE_MEMBERS) {
      expect(member in booting).toBe(false);
    }
    const runtime = await booting.ready;
    for (const member of REMOVED_HANDLE_MEMBERS) {
      expect(member in runtime).toBe(false);
    }
    await runtime.dispatch({ type: "go" });
    await runtime.stop();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("tag");
    expect(keys[0]).not.toContain("emit");
  });
});
