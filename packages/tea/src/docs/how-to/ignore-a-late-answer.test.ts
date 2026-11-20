// biome-ignore-all assist/source/organizeImports: regions mirror the page's import blocks in reading order.
import { describe, expect, it } from "vitest";

// #region search
import { type Cmd, defineMachine } from "@demlik/tea";
import { run } from "@demlik/tea/promise";

interface State {
  readonly query: string;
  readonly request: number;
  readonly results: readonly string[];
}
type Msg =
  | { readonly _tag: "search"; readonly query: string }
  | {
      readonly _tag: "answer";
      readonly request: number;
      readonly results: readonly string[];
    };
type Find = Cmd<"find"> & { readonly query: string; readonly request: number };

const unguardedSearch = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Find },
  init: (loaded) => [loaded ?? { query: "", request: 0, results: [] }, []],
  update: {
    search: (s, m) => {
      const request = s.request + 1;
      return [
        { query: m.query, request, results: [] },
        [{ _tag: "find", query: m.query, request }],
      ];
    },
    answer: (s, m) => [{ ...s, results: m.results }, []],
  },
});

// The service accepts requests now; the host delivers replies later.
async function answersOutOfOrder(machine: typeof unguardedSearch) {
  const requests: Find[] = [];
  const rt = await run(machine, {
    interpret: {
      find: async (cmd) => {
        requests.push(cmd);
      },
    },
  }).ready;
  try {
    for (const query of ["t", "te", "tea"]) {
      await rt.dispatch({ _tag: "search", query });
    }
    for (const { request } of [...requests].reverse()) {
      await rt.dispatch({
        _tag: "answer",
        request,
        results: [`result ${request}`],
      });
    }
    return rt.getState();
  } finally {
    await rt.stop();
  }
}

const broken = await answersOutOfOrder(unguardedSearch);
// broken: { query: "tea", request: 3, results: ["result 1"] }
// #endregion search

// #region identity
const search: typeof unguardedSearch = {
  ...unguardedSearch,
  identity: {
    ofState: (s) => s.request,
    ofMsg: (m) => (m._tag === "answer" ? m.request : undefined),
  },
};

const fixed = await answersOutOfOrder(search);
// fixed: { query: "tea", request: 3, results: ["result 3"] }
// #endregion identity

// #region manual
import { applyCell, matchesIdentity } from "@demlik/tea";

function step(state: State, msg: Msg): readonly [State, readonly Find[]] {
  return matchesIdentity(search.identity, state, msg)
    ? applyCell<State, Msg, Find>(search, state, msg)
    : [state, []];
}

let [manual] = search.init(null, undefined);
for (const query of ["t", "te", "tea"]) {
  [manual] = step(manual, { _tag: "search", query });
}
for (const request of [3, 2, 1]) {
  [manual] = step(manual, {
    _tag: "answer",
    request,
    results: [`result ${request}`],
  });
}
// manual: { query: "tea", request: 3, results: ["result 3"] }
// #endregion manual

// #region defined
import { Cmd as Command } from "@demlik/tea";
import { z } from "zod";

const find = Command.define("find", {
  input: z.object({ query: z.string(), request: z.number() }),
  ok: z.array(z.string()),
  err: ["unavailable"],
});

const definedSearch = defineMachine({
  types: {
    model: {} as State,
    msg: {} as { readonly _tag: "search"; readonly query: string },
  },
  cmds: [find],
  init: (loaded) => [loaded ?? { query: "", request: 0, results: [] }, []],
  update: {
    search: (s, m) => {
      const request = s.request + 1;
      return [
        { query: m.query, request, results: [] },
        [find({ query: m.query, request })],
      ];
    },
    find_ok: (s, m) => [{ ...s, results: m.value }, []],
    find_err: (s) => [{ ...s, results: [] }, []],
  },
  // A settled reply carries the Cmd it answers: read the request from `m.cmd`.
  identity: {
    ofState: (s) => s.request,
    ofMsg: (m) => (m._tag === "search" ? undefined : m.cmd.request),
  },
});

const latestState = { query: "tea", request: 3, results: [] };
const oldReply = find.ok(find({ query: "t", request: 1 }), ["result 1"], 0);
const newReply = find.ok(find({ query: "tea", request: 3 }), ["result 3"], 0);
matchesIdentity(definedSearch.identity, latestState, oldReply); // false: dropped
matchesIdentity(definedSearch.identity, latestState, newReply); // true: folded
// #endregion defined

describe("docs/how-to/ignore-a-late-answer.md — it runs", () => {
  it("reproduces the old answer winning, then keeps the newest result on the engine and manual host", () => {
    expect(broken).toEqual({ query: "tea", request: 3, results: ["result 1"] });
    const latest = { query: "tea", request: 3, results: ["result 3"] };
    expect(fixed).toEqual(latest);
    expect(manual).toEqual(latest);
  });

  it("drops an older settled reply of a Cmd.define'd effect by the request its cmd carries", () => {
    expect(matchesIdentity(definedSearch.identity, latestState, oldReply)).toBe(
      false,
    );
    expect(matchesIdentity(definedSearch.identity, latestState, newReply)).toBe(
      true,
    );
  });
});
