# Debug a run in Redux DevTools

To see what a running machine does, Msg by Msg, connect it to the
[Redux DevTools](https://github.com/reduxjs/redux-devtools) browser extension.
The panel then shows every [Msg](../glossary.md#msg) the run applied and the
[Model](../glossary.md#model) it produced. A session you export from the panel
can be imported again and replayed through your current code, and it can
become a regression test.

## 1. Connect the run

Install the extension for Chrome, Edge or Firefox. Then connect the run where
you start it:

```ts
import { connectReduxDevtools } from "@demlik/tea/devtools/redux";
import { run } from "@demlik/tea/promise";

const runtime = run(checkout, { ctx, interpret });
connectReduxDevtools(checkout, runtime, { dispatch: runtime.dispatch });
```

Pass the same machine you started the run from: import replays sessions
through it. Every option is listed under
[`connectReduxDevtools`](../reference/devtools-redux.md#connectReduxDevtools). Without the extension (in production, in Node, in a test) the call
returns `{ connected: false }` and does nothing, so it can stay in the code.
To stop listening, call `disconnect()` on what it returns.

## 2. Watch the run

Open the browser's developer tools and pick the **Redux** tab. Each applied Msg
is one action, named by its `type`, and selecting it shows the Model after it,
the Msg itself, and the diff from the Model before it. The first entry,
`@@INIT`, is the Model the run booted into. Set `name` in the options to tell
several runs apart in the instance picker.

## 3. Send a Msg from the panel

The panel's **Dispatch** button is on when you pass `dispatch`. The box opens
holding `{ type: '' }`; fill the Msg in as an object, the way you would write
it in code:

```js
{ type: 'add', sku: 'tea', price: 10 }
```

JSON works too. The text is read as data and never run, so it can hold strings,
numbers, booleans, `null`, arrays and objects, but not a variable or a call.

A Msg the current state has no [cell](../glossary.md#cell) for is not sent; the
panel shows the Msgs that state accepts instead. A Msg that is sent runs like
any other dispatch, effects included.

On the Effect engine, the handle's `dispatch` returns an Effect, so pass a
function that runs it:

```ts
connectReduxDevtools(checkout, handle, {
  dispatch: (msg) => appRuntime.runPromise(handle.dispatch(msg)),
});
```

## 4. Save a session and replay it through your current code

Press **Export** in the panel to download the session as `state.json`. It holds
the Msgs and the Model after each one.

Press **Import** and pick a saved file to replay it. The bridge replays the
Msgs through the machine you connected, without running a single effect, and
the panel shows the Models your current code computes. When they differ from
the recording, the panel names the first Msg where they part:

```text
tea: your current code diverges from this session at Msg #1 "add": state.cart[0].price was 10, now 9.
```

When your machine no longer has a cell for a recorded Msg (it was renamed, or
the state lost it), replay stops there and names it:

```text
tea: your machine cannot replay this session. Msg #22 "retry" has no cell in state "declined" (it accepts back).
```

Importing never changes the live run. The panel's jump, skip and reorder
buttons are switched off for the same reason: the run's effects already
happened, so rewinding its Model would leave it disagreeing with the world
those effects changed.

## 5. Turn the saved session into a test

Someone sends you a `state.json` with a bug in it. Read it with
`parseDevtoolsExport` and replay it with
[`replayTrace`](../reference/persistence.md#replayTrace):

```ts
import { readFileSync } from "node:fs";
import { parseDevtoolsExport } from "@demlik/tea/devtools/redux";
import { replayTrace } from "@demlik/tea/persistence";

it("the reported checkout replays", () => {
  const trace = parseDevtoolsExport<State, Msg>(
    readFileSync("fixtures/checkout-bug.json", "utf8"),
  );
  const result = replayTrace(checkout, trace);
  expect(result.divergence?.at).toBeUndefined();
  expect(result.refusal).toBeUndefined();
  expect(result.matches).toBe(true);
});
```

The test fails until the replay matches the recording. When it fails,
`result.divergence.at` names the Msg, `result.divergence.path` the field, and
`result.states` holds the Model after each Msg as your code computes it.

To get the same file without a browser, record the run with `recorder` from
`@demlik/tea/persistence` and `captureSteps: true`; its `toJSONL()` output reads
back with `parseJSONL` and replays the same way.
