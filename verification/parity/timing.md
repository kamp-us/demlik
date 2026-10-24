# Verify native timing and deadlines

Use the pinned Node 22.21.1/V8 reference and the isolated Rust environment
described in README.md.

```
pnpm --filter @demlik/parity verify:timing
pnpm --filter @demlik/parity verify:timing:coverage
pnpm --filter @demlik/parity verify:timing:mutations
cargo run --locked -p demlik-tea --example timing_search
```

The coverage check also reads the baseline `pnpm parity` report and freshly
discovers the public capabilities. `timing-contracts.json` records owned timing
capabilities and identifies imported Cmd/CmdDef callables by their canonical
core owner. Those shared functions use the core command consumer evidence.

`target/parity/timing.json` contains the differential cases, explicit failures,
compiled native call evidence, binary hash and exact engine profile. Shared
scripts call the actual TS functions and native Rust functions with deterministic
host timers. Requested delays and timer ownership/order remain visible in each
trace. The report records the pinned Node timer source hash behind its numeric
profile: delays outside [1, 2147483647] become 1 ms, and valid fractions truncate.
Platform diagnostic formatting, such as Node's overflow warning text, is outside
the scheduling trace.

The Rust `Timer` interface is a host adapter. `TokioTimer` uses the caller's
LocalSet and reports asynchronous callback failures, including the original
panic payload, to the supplied sink. Live wrappers expose `invoke`, `cancel`
and `flush`. Their `Rc<dyn Fn(A)>` callback can call the same wrapper again.
An armed callback retains its state until fire/cancel; detach a host listener
by explicitly calling `cancel`. Native lifecycle tests use actual Tokio timers
and prove asynchronous delivery and cancellation before the target.

The pure input slice shares immutable state through Rc. No-op transitions retain
identity, and no-cache values can borrow local data without Clone, Send,
serialization or static lifetime bounds. Dedupe configuration requires a key
function and uses the existing JsRecord cache. `restore_data` lets the caller
parse input values while preserving JSON's null clocks, missing undefined input
fields, and raw restored cache entries. Ordinary serde consumers remain useful
when their typed schema accepts the saved shape.

Deadline declarations hold absolute targets. The default runner recomputes the
remaining delay at each arm. An injected arm receives the id, absolute target,
message and dispatcher. Cleanup calls host cancels in list order and propagates
the first failure. A failed later arm leaves earlier arms live, matching the
source's partial setup behavior. These functions add no registry or provider
graph. Rust derives named wire tags at runtime; an application message enum
provides exhaustive machine dispatch instead of TypeScript's inferred
`${N}_deadline` literal type. Names/tags currently use UTF-8 String under the
shared `Tagged::tag() -> &str` interface. Lone-surrogate names remain a shared
tag-representation gap; deadline ids already use JsText.

The full port and runtime integration remain separate verification scopes.
Browser timer adapters and a Wasm target build have not been exercised here.
