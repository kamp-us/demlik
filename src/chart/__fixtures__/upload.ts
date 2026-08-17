// ═══════════════════════════════════════════════════════════════════════════
// THE CMD SURFACE — a second, deliberately effectful chart.
//
// Umut's lane region emits no Cmds, so it stays clean (see `lane.ts`). This is
// where effects get exercised: 0..n Cmds per edge, per-guard-arm emission, one
// builder shared by several sites, and a derived `init`.
//
// The Cmd union is DERIVED from the chart's `cmds` section: a cmd name is
// written once as a declaration (with its payload), then only referenced —
// on the edges that fire it, and by the builder that constructs its payload.
// ═══════════════════════════════════════════════════════════════════════════
import type { Sub } from "../../pure/core";
import { defineMachine } from "../../runtime-types";
import { compile, initFrom } from "../compile";
import {
  type CmdOf,
  type Cmds,
  defineChart,
  type MsgIn,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

export const upload = defineChart({
  events: {
    pick: { data: ty<{ readonly key: string }>(), scope: "edges" },
    done: { data: ty<{ readonly etag: string }>(), scope: "edges" },
    fail: { data: ty<{ readonly error: string }>(), scope: "edges" },
    ok: { scope: "edges" },
  },
  cmds: {
    put_object: ty<{ readonly key: string }>(),
    verify_object: ty<{ readonly key: string; readonly etag: string }>(),
    log: ty<{ readonly line: string }>(),
    alert_human: ty<{ readonly reason: string }>(),
  },
  states: {
    live: {
      // `initial: true` — the one place the entry state is written down.
      idle: {
        initial: true,
        data: ty<{ readonly tries: number }>(),
        on: { pick: { target: "sending", cmd: "put_object" } },
      },
      sending: {
        data: ty<{ readonly key: string; readonly tries: number }>(),
        on: {
          // an ORDERED LIST: two Cmds off one edge, in declaration order.
          done: { target: "checking", cmd: ["verify_object", "log"] },
          // per-arm emission: the guard decides WHICH effects fire, and that
          // decision is visible in the chart instead of inside a cell body.
          fail: {
            target: "idle",
            when: "hasBudget",
            otherwise: "dead",
            cmd: "log",
            otherwiseCmd: ["log", "alert_human"],
          },
        },
      },
      // an edge with no `cmd` at all → zero Cmds.
      checking: {
        data: ty<{
          readonly key: string;
          readonly etag: string;
          readonly tries: number;
        }>(),
        on: { ok: "idle" },
      },
    },
    finished: {
      dead: { data: ty<{ readonly tries: number }>(), end: true },
    },
  },
});

export type UG = typeof upload;
export type UState = StateOf<UG>;
export type UMsg = MsgOf<UG>;
export type UCmd = CmdOf<UG>;

export const uCmds: Cmds<UG, UState, UMsg> = {
  // ONE site (`idle.pick`) → exactly the idle state + the pick msg.
  put_object: (_s, m) => ({ key: m.key }),
  // ONE site (`sending.done`) → the sending state + the done msg.
  verify_object: (s, m) => ({ key: s.key, etag: m.etag }),
  // THREE sites (`sending.done`, and BOTH arms of `sending.fail`) → the
  // builder's params are the union of those sites, so the body must narrow.
  log: (s, m, at) => ({
    line:
      at === "sending.done" ? `stored ${s.key}` : `failed ${s.key}: ${m.error}`,
  }),
  // one site, the ELSE arm of `sending.fail` — `otherwiseCmd` sites feed the
  // same `SitesWhere` scan as `cmd` sites.
  alert_human: (s, m) => ({
    reason: `${s.key} dead after ${s.tries}: ${m.error}`,
  }),
};

export const uploader = compile(
  upload,
  {
    assign: {
      "idle.pick": (s, m) => ({ key: m.key, tries: s.tries }),
      "sending.done": (s, m) => ({ key: s.key, etag: m.etag, tries: s.tries }),
      "sending.fail": {
        // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
        then: (s) => ({ tries: s.tries + 1 }),
        else: (s) => ({ tries: s.tries }),
      },
      "checking.ok": (s) => ({ tries: s.tries }),
    },
    guards: { hasBudget: (s) => s.tries < 3 },
    cmds: uCmds,
  },
  "up",
);

export type UMsgIn = MsgIn<UG, "up">;

export const uploadMachine = defineMachine<
  UState,
  UMsgIn,
  UCmd,
  Sub<never>,
  Record<never, never>
>({
  init: initFrom<UG, UState, UCmd>(upload, () => ({ tries: 0 })),
  update: uploader,
  interpret: {
    put_object: async () => undefined,
    verify_object: async () => undefined,
    log: async () => undefined,
    alert_human: async () => undefined,
  },
});
