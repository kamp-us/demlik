# Layer rules

[Documentation index](../README.md) · [CLI flags](./cli.md)

```sh
pnpm exec code-graph . --layers --layer-rules layer-rules.json
```

Layers are an ordered list. Index 0 is the top; imports may go downward or
remain in the same layer, and a layer's `imports` can limit which lower layers
it reaches. No default stack ships. A missing or empty stack is an input error.

## Rules file

```json
{
  "layers": [
    { "name": "app", "paths": ["apps/web"] },
    { "name": "domain", "paths": ["packages/domain"] },
    { "name": "contract", "paths": ["packages/contracts"] }
  ],
  "allowed": [
    {
      "from": "packages/domain/src/order.ts",
      "to": "apps/web/src/config.ts",
      "sites": 1,
      "reason": "Pass this setting into the domain instead."
    }
  ]
}
```

At least two layers are required. Layer names and path patterns must be
unique. `allowed` may be omitted, so no violation is tolerated.

## Limiting what a layer imports

A layer may list the layers below it that it can import. This fails an import
that jumps past a layer:

```json
{
  "layers": [
    { "name": "app", "paths": ["src/app"], "imports": ["coordination"] },
    { "name": "coordination", "paths": ["src/coordination"], "imports": ["data"] },
    { "name": "data", "paths": ["src/data"], "imports": [] }
  ]
}
```

| `imports` | The layer may import |
|---|---|
| Key left out | Itself and every layer below it |
| `["coordination"]` | Itself and `coordination` |
| `[]` | Only itself |

Imports inside one layer pass whatever the list says. `imports` cannot grant an
upward edge: a name above the layer, or one that is not a declared layer, exits
2 with one line naming both, before any analysis.

An edge to a lower layer that the list leaves out breaks the rule
`outside-imports`; any edge to a higher layer breaks the rule `upward`. An
`allowed` entry excuses either kind, under the same site count and stale checks.
The census still counts an `outside-imports` edge as `down`.

When any layer declares `imports`, the report names the broken rule: each edge
line carries an `[upward]` or `[outside-imports]` tag, and each edge in the
`--json` `violations` and `undeclared` arrays has a `rule` field. A rules file
with no `imports` anywhere prints the same output as before the key existed, so
it has no tags and no `rule` field; every violation it reports is upward.

## Path matching

Paths are prefixes ending at a segment boundary: `packages/core` does not
match `packages/core-contract`.

| Pattern | Match |
|---|---|
| `services/*/src/domain` | One non-empty segment in place of `*` |
| `packages/*-contract` | `*` within a segment; never crosses `/` |
| `apps/**/domain` | Zero or more whole segments in place of `**` |

Other characters, including `?`, brackets, braces, and `!`, are literal.

When patterns overlap, specificity compares depth excluding `**`, then
literal segment count, then literal character count. A tie between different
layers is rejected. Files outside all patterns are counted as unlayered,
without a verdict on their imports.

## Imports and resolution

The pass reads static imports, re-exports, and dynamic imports from syntax.
It does not open tsgo or build a full Graph. Targets such as `.d.ts`, JSON,
and CSS can still be judged.

Path aliases resolve through the importing file's nearest tsconfig,
including `extends`. Broken relative imports or matching aliases are listed
as unresolved. Dependencies, builtins, and other external specifiers remain
external when they do not resolve into the repository.

## Gate policy

`--layers` exits 1 for an undeclared upward import, an undeclared import outside
a layer's `imports`, a stale allowlist entry, or a site count that differs from
the recorded count. It does not require `--ci`. Invalid declarations exit 2.

This monorepo tests layer-gate fixtures. Its build workflow does not run a
layer CLI gate against a stack for the entire monorepo; consuming repositories
choose their own stack and CI placement.

Source: [rules](../../src/layers/rules.ts),
[classification](../../src/layers/classify.ts),
[gate](../../src/layers/gate.ts).
