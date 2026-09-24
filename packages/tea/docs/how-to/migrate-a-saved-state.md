# Change a saved state's shape without losing old saves

A run with a `Store` saves its Model and reads it back at the next boot. When
you change the Model's shape, the saves already on disk still hold the old
shape. This page stamps a version on every save and walks an old save up to
the current version one step at a time, inside `migrate`.

tea has no version option or store wrapper for this, and needs none. The
version is a field of the Model, so every store saves it, and the loop is a
plain function you hand the store as its `migrate`.

## 1. Put the version in the Model

The settings below are on version 3. `version` is a field of the Model, so
every save writes `{ "version": 3, ... }`. The Model is its own versioned
envelope: no wrapper code writes the stamp. The type pins `version` to `3`, so
a Model on any other version does not typecheck.

## 2. Write one step per old version

`steps[n]` turns version n's fields into version n + 1's. `migrateSettings`
reads the saved version, runs each step from there up to the current one, and
checks the result:

```ts
import { defineMachine, type Migrated, refuse } from "@demlik/tea";

/** The settings version this build reads and writes. */
const CURRENT = 3;

/** Version 3 of the settings. `version` is saved with them on every write. */
export interface Settings {
  readonly version: typeof CURRENT;
  readonly theme: "light" | "dark";
  readonly fontSize: number;
  readonly compact: boolean;
}

export type SettingsMsg = { readonly type: "toggleCompact" };

export const settings = defineMachine({
  types: { model: {} as Settings, msg: {} as SettingsMsg },
  init: (loaded) => [
    loaded ?? {
      version: CURRENT,
      theme: "light",
      fontSize: 14,
      compact: false,
    },
    [],
  ],
  update: {
    toggleCompact: (s) => [{ ...s, compact: !s.compact }, []],
  },
});

type Fields = Record<string, unknown>;

/** `steps[n]` turns version n's fields into version n + 1's. */
const steps: Partial<Record<number, (old: Fields) => Fields>> = {
  // 1 → 2: the `dark` flag became a `theme`.
  1: ({ dark, ...rest }) => ({ ...rest, theme: dark ? "dark" : "light" }),
  // 2 → 3: `compact` was added.
  2: (old) => ({ ...old, compact: false }),
};

/** Walk saved settings up to the current version, one step at a time. */
export function migrateSettings(raw: unknown): Migrated<Settings> {
  if (raw === null) return null;
  if (typeof raw !== "object") {
    return refuse("the saved settings are not an object");
  }
  // Saves written before the stamp existed have no `version`: they are version 1.
  let { version = 1, ...fields } = raw as Fields;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return refuse("the saved version is not a whole number");
  }
  if (version > CURRENT) {
    return refuse(`settings version ${version} is newer than this build`);
  }
  while (version < CURRENT) {
    const step = steps[version];
    if (step === undefined) {
      return refuse(`no migration step from settings version ${version}`);
    }
    fields = step(fields);
    version += 1;
  }
  const { theme, fontSize, compact } = fields;
  return (theme === "light" || theme === "dark") &&
    typeof fontSize === "number" &&
    typeof compact === "boolean"
    ? { version: CURRENT, theme, fontSize, compact }
    : refuse(`the saved settings do not read as version ${CURRENT}`);
}
```

What it answers for each saved value:

- **Nothing saved:** `null`, so the run boots fresh.
- **A save with no `version`:** read as version 1, so saves written before you
  added the stamp still load.
- **An old version with every step in place:** each step runs once, in order,
  and the result is version 3 settings.
- **A version with no step:** `refuse`, naming the version. A save from a
  version you never shipped lands here, and so does one whose step you deleted.
- **A version newer than this build:** `refuse`. An older build that meets a
  newer save leaves it alone instead of reading it wrong.

The loop moves `version` itself, one up per step, so a step cannot skip a
version or send the walk back to an old one.

## 3. Hand it to the store

```ts
fileStore("settings.json", migrateSettings);
```

`fileStore` comes from `@demlik/tea/node`. Any `Store` takes the same function
as its `migrate`. A refusal makes `ready` reject with a `StoreRefusedError` and
leaves the saved bytes alone, so a later build that adds the missing step can
still read them. To show a view instead of failing, see
[Show a "couldn't restore" view](./restore-or-refuse.md).

## 4. Change the shape again

When the settings move to version 4:

1. Set `CURRENT` to `4` and update `Settings`.
2. Add `steps[3]`, which turns version 3's fields into version 4's.
3. Update the check at the end of `migrateSettings`.

Keep the old steps. A save can sit on disk across many releases, and it walks
every step from its version to the current one.

The page's example is `examples/versioned-save.ts`.
