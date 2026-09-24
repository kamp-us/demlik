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
