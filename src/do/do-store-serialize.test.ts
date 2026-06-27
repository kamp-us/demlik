/**
 * `doStore` (de)serialize hook (#182) — example tests.
 *
 * The sharp edge: `doStore.save` JSON-serializes the Model, and
 * `JSON.stringify` silently flattens a `Map` to `{}`. A Model that wants a
 * `Map` (the natural "roster keyed by id") supplies a `serialize` hook — the
 * inverse of `parse` — so the boundary owns both directions and the Map
 * round-trips. These tests pin: (a) the hook round-trips a Map Model, (b) the
 * default (no hook) silently loses the Map (the documented constraint), and
 * (c) the legacy positional-`key` string form still works.
 */

import { describe, expect, it } from "vitest";
import { doStore } from "./index";

// ── In-memory `DurableObjectStorage` fake (mirrors event-sourced-store.test). ──
function fakeStorage(backing: Map<string, string> = new Map()) {
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value as unknown as string);
    },
  };
  return { backing, storage: storage as unknown as DurableObjectStorage };
}

// A Model whose roster is keyed by id with a real `Map` — the shape the #182
// sharp edge bites. `count` is an ordinary JSON field that rides along.
interface Roster {
  readonly count: number;
  readonly members: Map<string, { readonly name: string }>;
}

// The JSON-safe carrier `serialize` produces and `parse` consumes: the Map is
// flattened to an entries array, everything else stays plain JSON.
interface RosterCarrier {
  readonly count: number;
  readonly members: ReadonlyArray<readonly [string, { readonly name: string }]>;
}

const serializeRoster = (s: Roster): RosterCarrier => ({
  count: s.count,
  members: [...s.members.entries()],
});

// `parse` is the inverse: it validates the carrier and rebuilds the Map. Returns
// `null` on any unrecognized shape (the `Store.migrate` never-throw contract).
function parseRoster(raw: unknown): Roster | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<RosterCarrier>;
  if (typeof c.count !== "number" || !Array.isArray(c.members)) return null;
  return { count: c.count, members: new Map(c.members) };
}

describe("doStore — (de)serialize hook round-trips a Map Model (#182)", () => {
  it("rebuilds the Map on load when `serialize`/`parse` are paired", async () => {
    const { backing, storage } = fakeStorage();
    const live: Roster = {
      count: 2,
      members: new Map([
        ["a1", { name: "Aragorn" }],
        ["b2", { name: "Boromir" }],
      ]),
    };

    // Write through a store WITH the serialize hook.
    const writer = doStore<Roster>(storage, parseRoster, {
      serialize: serializeRoster,
    });
    await writer.save(live);

    // The persisted bytes carry the entries array — the Map did NOT flatten.
    const persisted = JSON.parse(backing.get("@@state") as string);
    expect(persisted.members).toEqual([
      ["a1", { name: "Aragorn" }],
      ["b2", { name: "Boromir" }],
    ]);

    // A SECOND store over the same bytes (the eviction/rehydrate simulation)
    // reconstructs the live Model — a real `Map` again, entries intact.
    const reader = doStore<Roster>(storage, parseRoster, {
      serialize: serializeRoster,
    });
    const loaded = reader.migrate(await reader.load());
    expect(loaded).not.toBeNull();
    expect(loaded?.members).toBeInstanceOf(Map);
    expect(loaded?.members.get("a1")).toEqual({ name: "Aragorn" });
    expect(loaded?.members.get("b2")).toEqual({ name: "Boromir" });
    expect(loaded?.count).toBe(2);
  });

  it("the default (no hook) silently flattens a Map — the documented constraint", async () => {
    const { backing, storage } = fakeStorage();
    const live: Roster = {
      count: 1,
      members: new Map([["a1", { name: "Aragorn" }]]),
    };

    // No `serialize`: the identity default → `JSON.stringify` flattens the Map.
    const store = doStore<Roster>(storage, parseRoster);
    await store.save(live);

    const persisted = JSON.parse(backing.get("@@state") as string);
    // The Map became `{}` — every entry is gone. This is the sharp edge the
    // hook exists to close; without it the Model must stay plain-JSON.
    expect(persisted.members).toEqual({});
    expect(parseRoster(persisted)).toBeNull(); // not even a recognized shape
  });

  it("still accepts the legacy positional `key` string (backward compatible)", async () => {
    const { backing, storage } = fakeStorage();
    const store = doStore<Roster>(storage, parseRoster, "custom-key");
    await store.save({ count: 0, members: new Map() });
    // Wrote at the custom key, not the default `@@state`.
    expect(backing.has("custom-key")).toBe(true);
    expect(backing.has("@@state")).toBe(false);
  });
});
