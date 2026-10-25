# Owned command family names

`CmdDef::<Declaration>::new()` retains the declaration's static `NAME`.
`CmdDef::named(String)` owns a runtime UTF-8 name and carries it into each
`Cmd`. Dropping the definition leaves the command usable. `Cmd::definition()`
recovers that name and the same typed declaration without retaining a registry.
The declaration owns input/output types, schema parsing and declared failures.

`CommandSpec::Input` has no blanket serialization bound. `from_record` accepts
an explicit `CommandRecord` implementation for a trusted input struct without
a `type` field. External parsing, checked construction, serialization and hashes
keep their boundary-specific serde requirements. The native record consumer uses
borrowed strings and a non-Clone, non-serde `Cell` reference with an owned family
name. Its pure payload never crosses a wire boundary.

Engine settlement selects the command's carried name. Replay `ok`/`err`
builders deliberately use the receiver definition's name, including when a replay
builder references a differently named command. This follows the actual
`defineCmd` builders in `packages/tea/src/pure/core.ts`. There is no definition
pointer identity ban. `restore_command` decodes against a definition's name;
`restore_settled` accepts the replay builder's nested command name and never mints
runtime provenance. The default serde decoders still enforce static `NAME`.

The existing raw `CmdContract` remains the wire boundary for heterogeneous
serialized definitions. Its final definition of a duplicate name wins, matching
the source `cmdContractOver` map. `CmdDef::wire()` now uses its owned name too.
Typed declarations retain their own parser rather than creating a second registry.

Run from the checkout with the established isolated Rust environment:

```sh
pnpm --filter @demlik/parity exec node command-families-run.mjs
pnpm --filter @demlik/parity exec node command-families-mutations.mjs
cargo test --locked -p demlik-tea --test command_names --test command_records
```

The standalone reference imports the unchanged TypeScript source. The 40 traces
exercise paired names, duplicate names with different output transforms, empty,
escaped and ordinary Unicode names, replay cross references, successful and
malformed output, declared and undeclared failure data, absent outcomes, and
engine-owned dispatch stamps. The runner checks independent literals and exact
TS/Rust output equality. `target/parity/command-families.json` records the source
commit, exact Node/V8 versions, binary hash, passing public `observe!` calls and
failure details. No central runner or capability mappings are changed here.

The disposable mutation runner requires both drivers to execute successfully
before a behavioral difference counts. It alters the terminal name, wire name,
and foreign-engine provenance check independently and reports detections in
`target/parity/command-families-mutations.json`.

Blind spots: the shared `Tagged` interface still accepts UTF-8 names, so lone
UTF-16 surrogate names remain an explicit shared-owner gap. This is a command
seam checkpoint; composed resilient calls and the full port remain separate work.
