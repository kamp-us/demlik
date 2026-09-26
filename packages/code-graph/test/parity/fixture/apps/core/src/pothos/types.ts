import { builder, Open, Project } from "./refs";
import { db } from "drizzle-orm";

export function persistImplemented(): void { db.insert("t"); }
export function persistAttached(): void { db.insert("t"); }
export function persistAttachedMany(): void { db.insert("t"); }
export function persistSkipped(): void { db.insert("t"); }
export function persistInline(): void { db.insert("t"); }
export function persistOpenImplemented(): void { db.insert("t"); }
export function persistOpenAttached(): void { db.insert("t"); }

Project.implement({
  authScopes: (project: { orgId: string }) => ({ "org:member": project.orgId }),
  fields: (t) => ({
    implemented: t.field({ resolve: () => persistImplemented() }),
  }),
});

builder.objectField(Project, "attached", (t) =>
  t.field({ resolve: () => persistAttached() }),
);

builder.objectFields(Project, (t) => ({
  many: t.field({ resolve: () => persistAttachedMany() }),
}));

builder.objectField(Project, "skipped", (t) =>
  t.field({ skipTypeScopes: true, resolve: () => persistSkipped() }),
);

builder.objectType("Inline", {
  authScopes: { "user:authenticated": true },
  fields: (t) => ({
    inline: t.field({ resolve: () => persistInline() }),
  }),
});

Open.implement({
  fields: (t) => ({
    open: t.field({ resolve: () => persistOpenImplemented() }),
  }),
});

builder.objectField(Open, "attached", (t) =>
  t.field({ resolve: () => persistOpenAttached() }),
);
