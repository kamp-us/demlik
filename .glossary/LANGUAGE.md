# demlik architecture vocabulary (LANGUAGE)

The repo-owned architecture vocabulary. One row per term: the canonical definition, and where a name
has drifted, what the term is **not**. When the code and this file disagree, the code is
authoritative and this file is the doc to fix.

## The substrate
| Term | Definition | Not |
|---|---|---|
| Cmd | A one-shot side effect the reducer *asks for* and does not perform, named as an imperative verb-phrase, carrying `into` — the Msg constructor its result comes back as. | A Msg, and not the effect itself. A Cmd is a description the Runtime interprets. |
| Machine | The pure, inert definition of a system: its `init`, its `transitions` table and its `subscribe`. It describes behaviour and performs none. Canon: [`.patterns/tea/elm-canon.md`](../.patterns/tea/elm-canon.md). | A running thing. A Machine that is running is a Runtime. |
| Msg | A record that something **happened**, past tense, with the actor in the name — `UserClickedSignInButton`, not `WindowCreated`. Style is fixed by [`.patterns/tea/naming-style.md`](../.patterns/tea/naming-style.md); the actor is required, because impersonal names hide the causal story. | A request for something to happen. That is a Cmd. |
| Runtime | One running instance of a Machine — the thing that holds current state, accepts `dispatch`, reconciles Subs and performs Cmds. Created by `run`. | The Machine. One Machine can back many Runtimes. |
| State | A named way of being, and one of the finite set a Machine declares. The name is a noun or gerund-noun, never a verb. | The data carried alongside it. State is the name; the payload is the data the state holds. |
| Store | The persistence seam a Runtime folds through — `@demlik/tea/mem` in tests, `@demlik/tea/do` over a Durable Object. It has no Elm analogue; Elm does not expose one. | A cache or a database client. The Store is the substrate's own interface, not the storage behind it. |
| Sub | A continuous source of Msgs — a socket, a timer, an alarm — declared by `subscribe` as a function of state and reconciled by the Runtime. Named for its source, lowercase, and that name is also its `SubId`. | A Cmd. A Cmd fires once and is done; a Sub is live until state stops declaring it. |

## The seam
| Term | Definition | Not |
|---|---|---|
| brain | The pure half: the reducer and the data it folds. It decides, it never performs. Recipe: [`.patterns/tea/brain-hand-seam.md`](../.patterns/tea/brain-hand-seam.md). | A synonym for the Machine. The brain is the deciding half of one. |
| fold | Replaying an ordered event log through the reducer to arrive at current state. The event log is authoritative; folded state is derived and always reconstructible. | A snapshot. A snapshot is a cached fold, never a substitute for the log. |
| hand | The impure half: the adapters that actually perform what the brain asked for, and turn what comes back into Msgs. | The Runtime. The Runtime owns the hands; it is not one. |
| reducer | The pure function from (state, msg) to the next state plus any Cmds. Total over the cells the Machine declares, and free of IO by construction. | `update`, `handler` or `dispatch` — those name other things here; the pure function is the reducer. |

## The transition table
| Term | Definition | Not |
|---|---|---|
| cell | One entry in a Machine's transition table, at the intersection of a state and a `msg.type`. `applyCell` is the single dispatch primitive every stepping site goes through — `run`, replay, PBT and the `withX` wrappers alike. | A state, or a reducer. A cell is the (state, msg.type) pair those two meet at. |
| NoCellError | The named error thrown when dispatch reaches a state/`msg.type` pair the Machine declares no cell for — the guard that replaced a bare `TypeError` from inside `applyCell`, carrying both facts so the failure is actionable. | A validation error about the message's shape. The message may be perfectly well-formed and still have no cell in this state. |
