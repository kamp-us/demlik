type Env = {
  DB: D1Database;
  SESSIONS: KVNamespace;
};

export async function listInvoices(env: Env, organizationId: string) {
  const db = env.DB;
  return db.prepare("SELECT * FROM invoices WHERE organization_id = ?").bind(organizationId).all();
}

export async function endSessions(env: Env, keys: string[]) {
  await Promise.all(keys.map((key) => env.SESSIONS.delete(key)));
}

export function exportAll(env: Env) {
  return env.DB.dump();
}
