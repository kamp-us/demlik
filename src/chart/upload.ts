// ═══════════════════════════════════════════════════════════════════════════
// THE CMD SURFACE — a second, deliberately effectful graph.
//
// Umut's lane region emits no Cmds, so it stays clean (see `lane.ts`). This is
// where effects get exercised: 0..n Cmds per edge, per-guard-arm emission, one
// builder shared by several sites, and a derived `init`.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd, Sub } from "../pure/core";
import { defineMachine } from "../runtime-types";
import { compile, initFrom } from "./compile";
import {
  type Cmds,
  type MsgOf,
  type Namespaced,
  type StateOf,
  defineGraph,
} from "./graph";

export const upload = defineGraph({
  // `initial: true` — the one place the entry state is written down.
  idle: { initial: true, on: { pick: { target: "sending", cmd: "put_object" } } },
  sending: {
    on: {
      // an ORDERED LIST: two Cmds off one edge, in declaration order.
      done: { target: "checking", cmd: ["verify_object", "log"] },
      // per-arm emission: the guard decides WHICH effects fire, and that
      // decision is visible in the graph instead of inside a cell body.
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
  checking: { on: { ok: "idle" } },
  dead: {},
});

export type UG = typeof upload;

export type UState = StateOf<
  UG,
  {
    idle: { readonly tries: number };
    sending: { readonly key: string; readonly tries: number };
    checking: {
      readonly key: string;
      readonly etag: string;
      readonly tries: number;
    };
    dead: { readonly tries: number };
  }
>;

export type UMsg = MsgOf<
  UG,
  {
    pick: { readonly key: string };
    done: { readonly etag: string };
    fail: { readonly error: string };
    ok: Record<never, never>;
  }
>;

export type UCmd =
  | (Cmd<"put_object"> & { readonly key: string })
  | (Cmd<"verify_object"> & { readonly key: string; readonly etag: string })
  | (Cmd<"log"> & { readonly line: string })
  | (Cmd<"alert_human"> & { readonly reason: string });

export const uCmds: Cmds<UG, UState, UMsg, UCmd> = {
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
  alert_human: (s, m) => ({ reason: `${s.key} dead after ${s.tries}: ${m.error}` }),
};

export const uploader = compile<UG, UState, UMsg, UCmd, "up">(upload, "up", {
  assign: {
    "idle.pick": (s, m) => ({ key: m.key, tries: s.tries }),
    "sending.done": (s, m) => ({ key: s.key, etag: m.etag, tries: s.tries }),
    "sending.fail": {
      then: (s) => ({ tries: s.tries + 1 }),
      else: (s) => ({ tries: s.tries }),
    },
    "checking.ok": (s) => ({ tries: s.tries }),
  },
  guards: { hasBudget: (s) => s.tries < 3 },
  cmds: uCmds,
  unhandled: "error",
});

export type UMsgIn = Namespaced<UMsg, "up">;

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
