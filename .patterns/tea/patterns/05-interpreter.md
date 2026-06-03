# Pattern 05 — Where the Interpreter Lives = Your Architecture

## The claim

The interpreter is not a runtime detail. It is the **architectural locus** that
makes the rest of the discipline work. "Show me where your interpreter lives"
tells you more about your architecture than any diagram.

## What the interpreter does

The interpreter sits between the reducer (pure) and the real world (impure).
It receives inert effect-data from the reducer, performs the real-world act,
and loops produced events back to the same `dispatch` through the same `update`.

```
update(state, msg) → [newState, cmds]
                          ↓
                    interpreter(cmd)  ← the locus
                          ↓
                    real-world I/O
                          ↓
                      new Msg
                          ↓
                    dispatch(msg)
                          ↓
                    update(state, msg) → ...
```

## raj — the existence proof

raj's runtime is 34 lines. The interpreter is one line:

```javascript
function change (change) {
  state = change[0]
  var effect = change[1]
  if (effect) {
    effect(dispatch)   // ← the entire interpreter
  }
  view(state, dispatch)
}
```

Strip `effect(dispatch)` and you have a reducer with a vestigial second tuple
slot. The interpreter is what makes the system a system instead of a pile of
reducers.

raj proves the architecture does not depend on Elm. The type system, the compiler,
the no-FFI policy — these are enforcement mechanisms for the four invariants.
raj swaps compile-time enforcement for an opinionated 34-line surface too small
to abuse. The architecture survives the swap.

Source: https://github.com/andrejewski/raj

## The visibility ladder

How visible the interpreter is determines what kind of architecture you have:

| Visibility | Example | Consequence |
|-----------|---------|-------------|
| **Invisible** | Elm runtime | You can't customize it, but you can't break it either |
| **Explicit, singular** | raj `effect(dispatch)`, elm-ts BehaviorSubject | One place to look, one place to test |
| **Composable** | Effect-TS `Runtime<R>` | Multiple runtimes per boundary. Powerful, but you must learn fibers/layers/scopes |
| **Shattered** | Redux + thunks + sagas + observables | Four competing libraries, four mental models. The interpreter is nowhere and everywhere |

## Three TS-world answers — ranked by visibility

### elm-ts — interpreter is one explicit RxJS subject

The `Program` creates a `BehaviorSubject` that tracks `[Model, Cmd<Msg>]` pairs.
When `dispatch` is called, `update(msg, model)` runs and pushes the new pair onto
the subject. The Cmd half is subscribed to and executed. One subject, one loop.

Source: https://github.com/gcanti/elm-ts

### Effect-TS — runtime is a first-class composable value

`Runtime<R>` is held in a variable. You can have a default runtime, a request-scoped
runtime, a test runtime. The TEA loop with three changes:
1. "Msg" became a richer GADT (`Effect<A, E, R>`)
2. The interpreter became a value you can clone, fork, inject
3. Model is implicit (FiberRefs + Context) instead of explicit

The official docs say:
> "The runtime system creates a root fiber, initializing it with the initial
> context, FiberRefs, and effect. It then starts a loop, executing the
> instructions described by the `Effect` step by step."

Cost: you must learn fibers, layers, scopes, schedulers.

Source: https://effect.website/docs/runtime

### Redux + middleware — interpreter shattered

In Redux, the "interpreter" is split across:
- **Thunks**: async functions that dispatch (interpreter = closure inside action creator)
- **Sagas**: generator-based effects (interpreter = saga middleware)
- **Observables**: RxJS-based effects (interpreter = epic middleware)
- **redux-loop**: Cmd-as-data bolted back on (interpreter = store enhancer)

Four libraries. Four mental models. The interpreter is nowhere and everywhere.

## The connection to gen_server

The interpreter IS the mailbox. Elm's runtime is a gen_server in disguise:

| Elm | Erlang gen_server |
|-----|------------------|
| `Msg` | Message in the mailbox |
| `update` | `handle_call` / `handle_cast` |
| `Cmd` | `{noreply, NewState, Timeout}` / `gen_server:cast` |
| `Sub` | `handle_info` + process monitoring |
| Elm runtime | OTP supervisor + mailbox loop |

The gen_server predates Elm by decades. The shape is the same because the
problem is the same: manage state transitions with side effects in a
single-threaded loop.

Source: https://www.erlang.org/doc/design_principles/gen_server_concepts

## Practical lesson

When building a new TEA system, the first design question is:
**"Where does the interpreter live?"**

The answer determines:
- How testable the system is (can you skip the interpreter in tests?)
- How composable the system is (can you swap interpreters?)
- How debuggable the system is (can you log every effect before execution?)

A TEA system where the interpreter is explicit, singular, and co-located with
the machine definition is the most testable, composable, and debuggable option.
