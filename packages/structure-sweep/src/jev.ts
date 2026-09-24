import {
  decodeJevReply,
  isTransientJevAskErr,
  JEV_ENDPOINT,
  type JevAskErr,
  type JevHttpReply,
  type JevOk,
  type JevQuestionMap,
  type JevRequest,
  type JevState,
  jevAskErrOf,
} from "@demlik/tea/jev";
import {
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";

/** The model every command asks unless `--model` names another; pinned so a cached answer means one thing. */
export const DEFAULT_MODEL = "jev-1.13.0";

export const DEFAULT_RETRY: RetryPolicy = {
  baseMs: 500,
  factor: 2,
  capMs: 15_000,
  maxAttempts: 5,
  jitter: "full",
};

/**
 * One question map asked about one state. A command takes this, never a URL, so a test hands it a
 * stub and the command under test is the command that ships.
 */
export type JevClient<Q extends JevQuestionMap> = (
  state: JevState,
) => Promise<JevOk<Q>>;

/** A Jev call that failed for good: terminal on its first answer, or transient past the retry budget. */
export class JevAskError extends Error {
  constructor(readonly reason: JevAskErr) {
    super(`jev: ${JSON.stringify(reason)}`);
  }
}

export type JevPost = (request: JevRequest) => Promise<JevHttpReply>;

export function fetchPost(apiKey: string): JevPost {
  return async (request) => {
    const response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  };
}

export interface HttpJevOptions<Q extends JevQuestionMap> {
  readonly questions: Q;
  readonly model: string;
  readonly post: JevPost;
  readonly retry?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * The HTTP client: `@demlik/tea/jev` decodes each reply and says which failures are transient,
 * `@demlik/tea/retry-backoff` says whether and when to try again. Nothing here re-decides either.
 */
export function httpJevClient<Q extends JevQuestionMap>(
  options: HttpJevOptions<Q>,
): JevClient<Q> {
  const policy = options.retry ?? DEFAULT_RETRY;
  const sleep = options.sleep ?? wait;
  return async (state) => {
    const request: JevRequest<Q> = {
      state,
      model: options.model,
      questions: options.questions,
    };
    let retry = initRetry();
    for (;;) {
      let reason: JevAskErr;
      try {
        const outcome = decodeJevReply(request, await options.post(request));
        if (outcome._tag === "Ok") return outcome.value;
        reason = outcome.error.jev;
      } catch (cause) {
        reason = jevAskErrOf(cause);
      }
      retry = recordFailure(retry, reason);
      if (!isTransientJevAskErr(reason) || !shouldRetry(retry, policy)) {
        throw new JevAskError(reason);
      }
      await sleep(nextDelayMs(retry, policy));
    }
  };
}

export function requireApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.TYPESAFE_API_KEY;
  if (apiKey === undefined || apiKey === "")
    throw new Error("TYPESAFE_API_KEY is not set");
  return apiKey;
}

/** Run `work` over `items` with at most `size` in flight. */
export async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await work(item);
    }),
  );
}
