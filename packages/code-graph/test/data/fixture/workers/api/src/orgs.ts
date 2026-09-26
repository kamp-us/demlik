type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
};

export async function getOrganization(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM organizations WHERE id = ?").bind(id).first();
}

export async function renameOrganization(env: Env, id: string, name: string) {
  await env.DB.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).bind(name, id).run();
  await env.CACHE.delete(`org:${id}`);
}

export async function cachedOrganization(env: Env, id: string) {
  const { CACHE } = env;
  const hit = await CACHE.get(`org:${id}`);
  if (hit !== null) return hit;
  const org = await getOrganization(env, id);
  await CACHE.put(`org:${id}`, JSON.stringify(org));
  return org;
}

export function runQuery(env: Env, sql: string) {
  return env.DB.prepare(sql).all();
}

export class OrganizationRepository {
  constructor(readonly db: D1Database) {}
}

export function repository(env: Env) {
  return new OrganizationRepository(env.DB);
}
