type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
};

type Handler = (c: { env: Env }) => unknown;

declare const app: Record<"get" | "post", (path: string, handler: Handler) => void>;

app.get("/orgs", (c) => c.env.DB.prepare("SELECT * FROM organizations").all());

app.post("/orgs/flush", async (c) => {
  const { CACHE } = c.env;
  await CACHE.delete("orgs");
});

// A read beside a write, both `prepare`, on one line: two edges, not one.
export async function purgeOrganizations(env: Env) {
  const db = env.DB;
  return db.batch([db.prepare("SELECT id FROM orgs"), db.prepare("DELETE FROM orgs")]);
}
