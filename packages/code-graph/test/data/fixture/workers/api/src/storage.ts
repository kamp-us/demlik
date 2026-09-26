type Env = {
  COUNTER: DurableObjectNamespace;
  ASSETS: R2Bucket;
  EVENTS: Queue;
  API_TOKEN: string;
};

export async function bump(env: Env, name: string) {
  const stub = env.COUNTER.get(env.COUNTER.idFromName(name));
  return stub.fetch("https://counter/bump");
}

export async function archive(env: Env, key: string, body: string) {
  await env.ASSETS.put(key, body);
  await env.EVENTS.send({ key, token: env.API_TOKEN });
}

export class AssetReader {
  constructor(private readonly env: Env) {}

  async exists(key: string) {
    return (await this.env.ASSETS.head(key)) !== null;
  }
}
