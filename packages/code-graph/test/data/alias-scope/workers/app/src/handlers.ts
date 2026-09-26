type Env = { DB: D1Database; OTHER: D1Database };
type Context = { env: Env };
type App = Record<"get", (path: string, handler: (c: Context, db: D1Database) => unknown) => void>;

declare const app: App;
declare function openLocal(): D1Database;

// Sibling handlers at module scope reuse `db`; each one means its own.
app.get("/a", (c) => {
  const db = c.env.DB;
  return db.prepare("SELECT 1").all();
});
app.get("/b", (c) => {
  const db = c.env.OTHER;
  return db.prepare("SELECT 2").all();
});
app.get("/c", (_c, db) => db.prepare("SELECT 3").all());

// The same siblings inside one named function, where their sites become that function's edges.
export function mount(router: App) {
  router.get("/a", (c) => {
    const db = c.env.DB;
    return db.prepare("SELECT 1").all();
  });
  router.get("/b", (c) => {
    const db = c.env.OTHER;
    return db.prepare("SELECT 2").all();
  });
  router.get("/c", (_c, db) => db.prepare("SELECT 3").all());
  router.get("/d", () => {
    const db = openLocal();
    return db.prepare("SELECT 4").all();
  });
}

// An outer alias still reaches a callback that does not redeclare it.
export function nested(env: Env) {
  const db = env.DB;
  return [1, 2].map((id) => db.prepare("SELECT ?").bind(id));
}

// A block's `const db` shadows the outer alias inside that block only.
export function blocks(env: Env, items: number[], f: boolean) {
  const db = env.DB;
  return items.map(() => {
    db.prepare("SELECT 5");
    if (f) {
      const db = openLocal();
      return db.prepare("SELECT 6");
    }
    return db.prepare("SELECT 7");
  });
}

// Sibling blocks each declare their own `db`; only the aliasing one reaches a binding.
export function branches(env: Env, f: boolean) {
  if (f) {
    const db = env.DB;
    return db.prepare("SELECT 8");
  } else {
    const db = openLocal();
    return db.prepare("SELECT 9");
  }
}

// A `var` belongs to its function, so it stays bound after the block that declares it.
export function hoisted(env: Env, f: boolean) {
  if (f) {
    var db = env.DB;
  }
  return db.prepare("SELECT 10");
}
