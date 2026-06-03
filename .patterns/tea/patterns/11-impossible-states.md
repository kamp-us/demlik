# Pattern 11 — Making Impossible States Impossible

## The principle

Model your state so that invalid combinations cannot be represented.
If a state is impossible, the type should make it unrepresentable — don't rely
on runtime checks or discipline to prevent it.

## From the Elm guide — HTTP example

The HTTP example models loading state as a custom type, not boolean flags:

```elm
-- CORRECT — impossible states are unrepresentable
type Model
  = Failure
  | Loading
  | Success String
```

There is no state where `isLoading = true` AND `data = "some text"`. The type
makes it impossible. Compare to the boolean-flag version:

```typescript
// WRONG — impossible states are representable
type Model = {
  isLoading: boolean
  error: string | null
  data: string | null
}
// Can represent { isLoading: true, error: "fail", data: "text" }
// — all three simultaneously. Nonsense state.
```

## The rule: discriminated unions over boolean flags

Every time you reach for a boolean flag that controls "mode" or "phase,"
use a discriminated union instead.

```typescript
// WRONG — boolean flags multiply possible states
type Model = {
  isLoading: boolean    // 2 states
  hasError: boolean     // × 2 states
  isSubmitted: boolean  // × 2 states = 8 possible, ~3 valid
}

// CORRECT — only valid states exist
type Model =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; data: Data }
  | { type: "failure"; error: Error }
  | { type: "submitted" }
```

## The corollary: each phase carries only its own data

Don't put `data?: T` on every phase. Put `data: T` on the phase that has it.

```typescript
// WRONG — optional fields across phases
type Model = {
  phase: "loading" | "ready" | "error"
  data?: Data      // exists only in "ready" — why is it on every phase?
  error?: Error    // exists only in "error"
}

// CORRECT — data lives where it belongs
type Model =
  | { type: "loading" }
  | { type: "ready"; data: Data }
  | { type: "error"; error: Error }
```

Now `state.data` is only accessible when `state.type === "ready"`. TypeScript
narrows it. No `if (state.data)` guards needed.

## Elm's `viewValidation` — validation as a function, not state

From the Forms example:

```elm
viewValidation : Model -> Html msg
viewValidation model =
  if model.password == model.passwordAgain then
    div [ style "color" "green" ] [ text "OK" ]
  else
    div [ style "color" "red" ] [ text "Passwords do not match!" ]
```

Validation is derived from Model, not stored in it. There is no
`isValid: boolean` field — it's computed when needed.

## The "two fields that must agree" smell

If two fields must always be updated together, they should be one field:

```typescript
// WRONG — can desync
type Model = {
  selectedId: string | null
  selectedItem: Item | null
}

// CORRECT — one field, always consistent
type Model = {
  selection: { id: string; item: Item } | null
}
```

## In TEA: Model is the single source of truth

Invariant 1 says update is pure. Making impossible states impossible is the
Model-design corollary: if the Model can only represent valid states, and
update is the only way to change the Model, then the system can never enter
an invalid state.

This is stronger than runtime validation. Runtime validation catches
invalid states after they happen. Impossible states prevent them from
existing at all.

## Decision table

| You have... | Do this |
|------------|---------|
| `isLoading: boolean` + `data?: T` | Replace with `Loading \| Success T` union |
| Two fields that must agree | Merge into one field |
| `isValid: boolean` derived from other fields | Delete it, compute in view |
| `status: string` with 3+ values | Replace with discriminated union |
| Optional fields that exist only in certain "modes" | Move them into the mode's variant |

Source: Elm guide HTTP example — https://guide.elm-lang.org/effects/http.html
Source: Richard Feldman — "Making Impossible States Impossible" (Elm Conf 2016)
