import { db } from "drizzle-orm";
declare function field(config: object): void;
declare function relayMutationField(name: string, input: object, config: object): void;

export function persistScoped(): void {
  db.insert("t");
}

export function persistMutation(): void {
  db.insert("t");
}

export function persistOpen(): void {
  db.insert("t");
}

field({
  authScopes: (org: { id: string }) => ({ "org:member": org.id }),
  resolve: () => persistScoped(),
});

relayMutationField("upload", {}, {
  authScopes: { "org:admin": true },
  resolve() {
    persistMutation();
  },
});

field({
  resolve: () => persistOpen(),
});
