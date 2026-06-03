# Pattern 16 — Module Boundaries (When to Split)

## The principle — from Evan Czaplicki's "Life of a File"

Don't split files to keep them short. Split when a data structure emerges
that has its own invariants worth protecting.

Source: Evan Czaplicki — "Life of a File" (Elm Europe 2017)
https://www.youtube.com/watch?v=XpDsk374LDE

## Decision flowchart

1. Is there a data structure with its own invariants? → **Extract**
2. Can you write property-based tests for it? → **Extract**
3. Do you need to protect an API from misuse? → **Extract**
4. Is the file long but cohesive? → **Don't extract**
5. Would extracting create coupling between the modules? → **Don't extract**

## The two mechanics of modules

1. **Organize:** Group functions, values, types that belong together
2. **Hide:** Expose only what consumers need; hide internals that enforce invariants

## Rules

| When | Do | Because |
|------|-----|---------|
| A file is getting long but everything in it is cohesive | Keep it in one file | Line count is not a quality metric. In pure FP there's no spooky action at a distance, so long files aren't dangerous the way they are in mutable OO. |
| A data structure emerges with its own properties and operations | Extract it into a module that owns the type and hides internals | The module boundary protects invariants — consumers can't construct invalid values. |
| You can write property-based tests for a subset of functionality | That's a signal for a module boundary | If it has a testable property, it has an invariant; invariants warrant module-level protection. |
| You're tempted to pre-split "just in case" | Don't — wait until you feel the pain, then split | Premature abstractions are tech debt. You can always extract later. |
| You need to decide what axis to split on | Split around domain concepts, never around syntax categories | `User.ts`, `Email.ts` (domain) — yes. `Types.ts`, `Helpers.ts`, `Constants.ts` (syntax) — never. |

## Scaling TEA — from Richard Feldman

Source: Richard Feldman — "Scaling Elm Apps" (Elm Europe 2017)
https://www.youtube.com/watch?v=DoA4Txr4GUs

| When | Do | Because |
|------|-----|---------|
| An update branch gets too big | Extract a helper function with the narrowest possible arguments | Narrow type signatures make debugging faster. Your update function stays scannable. |
| You want to share logic across update branches | Create functions that take a subset of the model | Avoids breaking up Model/Msg/update while still getting polymorphism. |
| You're tempted to create a child Model/Msg/update triplet | Don't, unless it's a truly reusable component with its own lifecycle | Mini-update functions that return `(model, Cmd)` and must be mapped back add coordination complexity for no reuse gain. |
| A view is stateful (date picker, autocomplete, map) | Use Web Components to encapsulate DOM-level state, keep TEA state flat | Web Components encapsulate imperative DOM state that doesn't belong in your model. |
| Your update function feels like a giant switch | Think of it as a **delegator** — it routes to the right place, doesn't do the work itself | update's job is dispatch, not implementation. Implementation lives in narrow helpers. |

### The "Nested TEA" trap

Creating `PageMsg`, `PageModel`, `pageUpdate` for every page and mapping
them in a parent. This creates a tree of types without clear boundaries.

The Feldman approach: one flat Model, one flat Msg, narrow helper functions.
Only create sub-machines when they have **independent identity** (their own
lifecycle, their own subscriptions).

## Opaque types — protecting invariants

Source: Elm Radio #2 — Opaque Types
Source: Elm Radio #51 — Primitive Obsession

| When | Do | Because |
|------|-----|---------|
| A value has invariants (must be positive, valid email, non-empty) | Wrap in an opaque/branded type with a validating constructor | Once created, downstream code can't violate the invariant. |
| Two values of the same primitive type could be confused | Wrap each in its own type (`UserId` vs `OrderId`) | Compiler prevents passing a userId where an orderId is expected. |
| A boolean parameter controls behavior | Replace with a discriminated union | Boolean blindness: callers see `fn(true)` and have no idea what `true` means. |

In TypeScript:
```typescript
// Branded type — the TS equivalent of Elm's opaque type
type UserId = string & { readonly __brand: unique symbol }
type OrderId = string & { readonly __brand: unique symbol }

// Constructor that validates
function parseUserId(raw: string): UserId | null {
  return raw.length > 0 ? raw as UserId : null
}
```

**"Wrap Early, Unwrap Late":**
- Parse raw data into domain types at the boundary (API response, user input, port)
- Pass domain types through all internal logic
- Unwrap back to primitives only at the output boundary (DB write, API request, DOM)

## Parse, Don't Validate — at the boundary

Source: Elm Radio #4 — JSON Decoders

| When | Do | Because |
|------|-----|---------|
| Receiving data from ports, flags, or HTTP | Decode explicitly into your ideal type | Boundary data is untrusted. Parse it. |
| JSON shape doesn't match your ideal type | Design your type first, write a decoder that transforms | Decoders decouple serialization from domain types. Don't model your domain after your API's wire format. |
| You want to validate data during decoding | Reject invalid data in the decoder, not downstream | Fail at the boundary so the core can trust its types. |

Elm decoders. Zod schemas. Both are the same move: parse at the boundary
so the core never sees invalid data.

## Cross-cutting decision table

| Question | Decision Rule |
|----------|--------------|
| Should I create a child Model/Msg/update? | Only if it has independent identity (own lifecycle, own subscriptions). Otherwise use narrow helper functions. |
| Should I split this file? | Only when a data structure emerges with invariants worth protecting. Never for line count. |
| Should this be a type or a test? | Types for structural impossibility (wrong state can't exist). Tests for behavioral correctness (right thing happens). |
| Should I use a primitive or a wrapper? | Wrapper whenever two values of the same primitive type could be confused, or when the value has constraints. |
| Where should I validate data? | At the boundary. Decode/parse into ideal types on entry. Never re-validate downstream. |
| Should I use Boolean or custom type? | Custom type. Booleans are boolean-blind — they don't carry meaning at the call site. |
| Should I mirror external data shapes internally? | No. Design ideal internal types first, write parsers to transform external shapes into them. |
| When should I mock? | Never. Restructure so the thing you're testing is a pure function. Effects are data; test the data. |
