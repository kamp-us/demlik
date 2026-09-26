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
  /**
   * `detail` is the provider's own `error.message` / `error.code`, bounded by
   * {@link DETAIL_MAX_LENGTH}: the readable half of an account error that `reason` reduces to a status.
   */
  constructor(
    readonly reason: JevAskErr,
    readonly detail?: string,
  ) {
    super(`jev: ${JSON.stringify(reason)}${detail ? `: ${detail}` : ""}`);
  }
}

/** The longest provider error text a {@link JevAskError} carries. */
export const DETAIL_MAX_LENGTH = 500;

/** The provider's `error.message` / `error.code` off a failed reply's body, bounded; absent when it names neither. */
function jevErrorDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const error = isRecord(body.error) ? body.error : body;
  const parts = [error.message, error.code, body.error].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.length === 0
    ? undefined
    : parts.join("; ").slice(0, DETAIL_MAX_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` with every occurrence of `secret` in its strings, object keys included, replaced by `[redacted]`. */
function redactSecret(value: unknown, secret: string): unknown {
  if (secret === "") return value;
  if (typeof value === "string") return value.replaceAll(secret, "[redacted]");
  if (Array.isArray(value))
    return value.map((item) => redactSecret(item, secret));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(secret, "[redacted]"),
        redactSecret(item, secret),
      ]),
    );
  return value;
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
    const body: unknown = await response.json().catch(() => ({}));
    // An error body can echo request material, so the key never leaves here inside one.
    return {
      status: response.status,
      body: response.status >= 400 ? redactSecret(body, apiKey) : body,
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
      let detail: string | undefined;
      try {
        const reply = await options.post(request);
        if (reply.status >= 400) detail = jevErrorDetail(reply.body);
        const outcome = decodeJevReply(request, reply);
        if (outcome._tag === "Ok") return outcome.value;
        reason = outcome.error.jev;
      } catch (cause) {
        reason = jevAskErrOf(cause);
      }
      retry = recordFailure(retry, reason);
      if (!isTransientJevAskErr(reason) || !shouldRetry(retry, policy)) {
        throw new JevAskError(reason, detail);
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
