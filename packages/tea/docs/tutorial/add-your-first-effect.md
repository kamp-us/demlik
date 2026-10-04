# Add your first effect

In [the first lesson](./build-your-first-machine.md) you played the outside
world yourself: you dispatched every chunk by hand, and `update` returned an
empty effect list each time. In this lesson the machine asks for its own work.
You declare one [Cmd](../glossary.md#cmd), return it from `update`, write the
[handler](../glossary.md#handler) that performs it, and watch its result come
back as a [Msg](../glossary.md#msg), once as a success and once as a failure.
Then you add a second Cmd and watch the two run in order.

The download here reads a file from your disk, so the lesson needs no network
and no API key.

## Pick up where you left off

Work in the project folder from the first lesson. It already has `@demlik/tea`,
TypeScript and the `tsconfig.json` you wrote. Add one package:

```sh
pnpm add zod
```

A Cmd declares the shape of its input and its result, and `zod` is what you
write those shapes with.

Leave `main.ts` as it is. This lesson is a new file beside it, `effects.ts`.
Every TypeScript block below goes into it, in the order you meet them. Start it
with the imports:

```ts
// effects.ts
import { readFile } from "node:fs/promises";
import { Cmd, defineMachine } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
import { z } from "zod";
```

## Declare the Cmd

A Cmd is a plain object that describes one piece of work. `Cmd.define` declares
one: its name, what it takes, what it gives back when it works, and the ways it
can fail.

```ts
const fetchFile = Cmd.define("fetch_file", {
  input: z.object({ path: z.string() }),
  ok: z.object({ text: z.string() }),
  err: ["not_found"],
});
```

`fetchFile` takes a path. When it works it gives back the file's text. It can
fail in one way, and that way has a name: `not_found`.

Nothing has run yet. `fetchFile({ path: "package.json" })` only builds the
object `{ type: "fetch_file", path: "package.json" }`.

## Give the Model a place for failure

The first lesson's download could only succeed. This one can fail, so the Model
gets a `failed` phase that carries the reason:

```ts
type State =
  | { readonly phase: "idle" | "downloading" | "done" }
  | { readonly phase: "failed"; readonly reason: string };

type Msg = { readonly type: "start"; readonly path: string };
```

`start` is the only Msg you write. The other two come from the Cmd.

## Return the Cmd from `update`

List the Cmd under `cmds`, then return it from the `start` cell in the list
that was empty in the first lesson:

```ts
const downloader = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  cmds: [fetchFile],
  init: (loaded) => [loaded ?? { phase: "idle" }, []],
  update: {
    start: (_s, m) => [{ phase: "downloading" }, [fetchFile({ path: m.path })]],
    fetch_file_ok: (_s) => [{ phase: "done" }, []],
    fetch_file_err: (_s, m) => [{ phase: "failed", reason: m.error._tag }, []],
  },
});
```

Listing `fetchFile` under `cmds` gives `update` two more cells to fill:
`fetch_file_ok` for the success Msg and `fetch_file_err` for the failure Msg.
You did not add them to `Msg`, and leaving either cell out is a compile error.

`update` is still pure. The `start` cell does not read a file. It returns a
Cmd that says "read this file", and moves the Model to `downloading`.

## Write the handler

The work happens in a handler, and you hand it to `run` under
[`interpret`](../glossary.md#interpret), keyed by the Cmd's name:

```ts
const runtime = await run(downloader, {
  interpret: {
    fetch_file: async (cmd, { ok, err }) => {
      try {
        return ok({ text: await readFile(cmd.path, "utf8") });
      } catch {
        return err({ _tag: "not_found" });
      }
    },
  },
}).ready;
```

The handler gets the Cmd and two functions. It returns `ok(...)` with the
result when the read works, and `err(...)` with one of the Cmd's failure tags
when it does not. The engine turns `ok` into a `fetch_file_ok` Msg and `err`
into a `fetch_file_err` Msg, and dispatches it for you.

Notice the handler returns the failure. It does not throw it.

## Run it and watch both Msgs arrive

`runtime.observe` calls you back after every Msg with the Msg and the Model it
produced. Print each one, then start two downloads: a file that exists, and one
that does not.

```ts
runtime.observe((msg, state) => console.log(msg.type, "->", state.phase));

await runtime.dispatch({ type: "start", path: "package.json" });
await runtime.dispatch({ type: "start", path: "missing.json" });

console.log(runtime.getState());
await runtime.stop();
```

Check the types, then run the file:

```sh
pnpm exec tsc --noEmit
node --experimental-strip-types effects.ts
```

`tsc` prints nothing. Node prints:

```text
start -> downloading
fetch_file_ok -> done
start -> downloading
fetch_file_err -> failed
{ phase: 'failed', reason: 'not_found' }
```

Read it top to bottom. You dispatched `start` and nothing else. The first
download found `package.json`, so the handler returned `ok` and
`fetch_file_ok` arrived. The second found no `missing.json`, so the handler
returned `err` and `fetch_file_err` arrived, and its tag is now in your Model.

You just ran your first effect.

## Add a second effect

A download that throws the text away is not much use. Save it to a second file
with a second Cmd, which runs after the first one succeeds.

Each change below is shown as a diff. Delete the lines that start with `-`, add
the lines that start with `+`, and leave the rest alone.

Import `writeFile`:

```diff
-import { readFile } from "node:fs/promises";
+import { readFile, writeFile } from "node:fs/promises";
```

Declare the Cmd under the first one. It takes a path and the text, gives back
nothing, and can fail in one way of its own:

```diff
   err: ["not_found"],
 });
+
+const saveFile = Cmd.define("save_file", {
+  input: z.object({ path: z.string(), text: z.string() }),
+  ok: z.object({}),
+  err: ["not_saved"],
+});
```

List it in the machine:

```diff
-  cmds: [fetchFile],
+  cmds: [fetchFile, saveFile],
```

Return it from the `fetch_file_ok` cell, and move `done` to the new
`save_file_ok` cell:

```diff
-    fetch_file_ok: (_s) => [{ phase: "done" }, []],
+    fetch_file_ok: (_s, m) => [
+      { phase: "downloading" },
+      [saveFile({ path: "copy.json", text: m.value.text })],
+    ],
+    save_file_ok: (_s) => [{ phase: "done" }, []],
+    save_file_err: (_s, m) => [{ phase: "failed", reason: m.error._tag }, []],
```

The success Msg carries what the handler passed to `ok`, as `m.value`. That is
how the text gets from the first effect to the second.

Add the handler:

```diff
       }
     },
+    save_file: async (cmd, { ok, err }) => {
+      try {
+        await writeFile(cmd.path, cmd.text);
+        return ok({});
+      } catch {
+        return err({ _tag: "not_saved" });
+      }
+    },
   },
 }).ready;
```

Check and run again:

```sh
pnpm exec tsc --noEmit
node --experimental-strip-types effects.ts
```

Node prints:

```text
start -> downloading
fetch_file_ok -> downloading
save_file_ok -> done
start -> downloading
fetch_file_err -> failed
{ phase: 'failed', reason: 'not_found' }
```

The first download now runs two effects in order: the fetch, then the save.
There is a new `copy.json` in your folder with the same text as
`package.json`. The second download fails at the fetch, so `update` never
returns `saveFile` and nothing is saved.

You wrote no `await` chain to get that order. Each effect's result came back as
a Msg, and `update` decided what to do next.

## Where to go next

- [Cmd or Sub: do this once, or tell me whenever](../explanation/cmd-or-sub.md)
  says when work is a Cmd and when it is something else.
- [Why failures are values and bugs are throws](../explanation/errors-as-data.md)
  says why the handler returned `err` where you might have thrown.
- The [glossary](../glossary.md) defines every word this lesson used.
- [Build a durable agent](./build-a-durable-agent.md) is the next lesson.
