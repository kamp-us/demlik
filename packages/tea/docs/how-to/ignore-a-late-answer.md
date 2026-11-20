# Ignore an answer that arrives too late

When a search box starts a new request before the previous one finishes, an
older answer can overwrite the newest results. Declare the machine's `identity`
so the engine drops answers addressed to an older request before `update` runs.

## 1. Reproduce the old answer winning

This search machine increments its request number when the query changes. The
handler carries that number back from the command. The controlled service
answers three requests in reverse order, so the oldest result wins:

```ts
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
```

## 2. Declare which request an answer belongs to

Keep the same update cells. `ofState` selects the current request; `ofMsg`
selects the request an answer addresses. Return `undefined` for a search input,
so the input that starts a new request always reaches `update`.

```ts
const search: typeof unguardedSearch = {
  ...unguardedSearch,
  identity: {
    ofState: (s) => s.request,
    ofMsg: (m) => (m._tag === "answer" ? m.request : undefined),
  },
};

const fixed = await answersOutOfOrder(search);
// fixed: { query: "tea", request: 3, results: ["result 3"] }
```

The request number changes even if the user types the same query again. Using
the query text alone as identity would admit an old answer for that same text.
The Promise and Effect engines both apply this filter. This ignores old answers;
it does not cancel the underlying search service's work.

## 3. Step the machine in your own host

`applyCell` does not apply the identity filter. A host that steps by hand must
call `matchesIdentity` first, reading the same identity the machine declares:

```ts
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
```

The engine and manual host both finish with request 3's results. `foldMsgs`
and `replay` also leave identity filtering to their caller.

## 4. When the effect is a `Cmd.define`d one

A `Cmd.define`d effect settles as `<name>_ok` or `<name>_err`, and that reply
carries the Cmd it answers as `cmd`. Put the request number in the Cmd's input
and read it back from `m.cmd`:

```ts
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
```

See the [`matchesIdentity` reference](../reference/tea.md#matchesIdentity).
