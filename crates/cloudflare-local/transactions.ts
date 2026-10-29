import { z } from "zod";
import { doStore } from "../../packages/tea/src/do/index";
import { StoreConflictError } from "../../packages/tea/src/index";

const command = z.strictObject({
  action: z.enum([
    "reset",
    "commit",
    "rollback",
    "sdk-error",
    "sdk-reject",
    "commit-reject",
    "cancel",
    "fenced",
    "delete",
    "fenced-delete",
    "inspect",
  ]),
});
const counter = z.strictObject({ count: z.number().int() });

export async function transactions(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const parsed = command.safeParse(await request.json());
  if (!parsed.success)
    return new Response("invalid transaction command", { status: 400 });
  const { action } = parsed.data;
  let outcome: unknown = null;
  if (action === "reset") {
    const cells = await storage.list({ prefix: "tx/" });
    if (cells.size) await storage.delete([...cells.keys()]);
  } else if (action === "commit") {
    const owner = { token: "borrowed" };
    const result = await storage.transaction(async (txn) => {
      await txn.put("tx/commit/a", "kept");
      await txn.put("tx/commit/b", 7);
      await txn.put("tx/other", false);
      await txn.put("tx/null", null);
      await txn.put("tx/commit/u", "\ud800");
      const cells = await txn.list({ prefix: "tx/commit/" });
      if (cells.size !== 3) throw new Error("transaction prefix query failed");
      return owner;
    });
    outcome = { kind: "commit", borrowed_result: result === owner };
  } else if (action === "rollback") {
    const owner = { token: "borrowed" };
    const original = { owner, payload: { code: 41 } };
    try {
      await storage.transaction(async (txn) => {
        await txn.put("tx/rollback/a", "must disappear");
        await txn.put("tx/rollback/b", 99);
        await txn.delete("tx/commit/a");
        throw original;
      });
      throw new Error("body failure unexpectedly committed");
    } catch (error) {
      const isOriginal = (value: unknown): value is typeof original =>
        value === original;
      if (!isOriginal(error)) throw error;
      outcome = {
        kind: "body",
        original_error: error === original,
        borrowed_owner: error.owner === owner,
        payload: error.payload.code,
      };
    }
  } else if (action === "sdk-error") {
    let original: unknown;
    try {
      await storage.transaction(async (txn) => {
        await txn.put("tx/sdk/before", "must disappear");
        try {
          txn.rollback();
          await txn.put("tx/sdk/after", "invalid after rollback");
        } catch (error) {
          original = error;
          throw error;
        }
      });
      throw new Error("rolled-back transaction unexpectedly accepted write");
    } catch (error) {
      if (error !== original || !(error instanceof Error)) throw error;
      outcome = {
        kind: "sdk",
        original_error: error === original,
        message: error.message,
      };
    }
  } else if (action === "sdk-reject" || action === "commit-reject") {
    const atCommit = action === "commit-reject";
    const originalMethod = storage.transaction;
    const original = new Error(
      atCommit ? "injected commit rejection" : "injected early SDK rejection",
    );
    let bodyRan = false;
    storage.transaction = async <T>(
      body: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> => {
      if (!atCommit) throw original;
      await originalMethod.call(storage, async (txn) => {
        await body(txn);
        throw original;
      });
      throw new Error("fault control unexpectedly resolved");
    };
    try {
      await storage.transaction(async (txn) => {
        bodyRan = true;
        await txn.put("tx/rejected", "must disappear");
        return { owner: "retained until settlement" };
      });
      throw new Error("SDK rejection unexpectedly accepted");
    } catch (error) {
      if (error !== original) throw error;
      outcome = {
        kind: atCommit ? "commit-reject" : "sdk-reject",
        original_error: error === original,
        body_ran: bodyRan,
        message: original.message,
      };
    } finally {
      storage.transaction = originalMethod;
    }
  } else if (action === "cancel") {
    await storage.transaction(async (txn) => {
      await txn.put("tx/cancel/a", "must disappear");
      txn.rollback();
    });
    outcome = { kind: "cancelled" };
  } else if (action === "fenced") {
    const store = doStore(storage, (raw) => counter.parse(raw), {
      key: "tx/fenced",
      fenced: true,
    });
    const first = await store.loadFenced();
    const stale = await store.loadFenced();
    const version = await store.saveFenced({ count: 1 }, first.version);
    try {
      await store.saveFenced({ count: 100 }, stale.version);
      throw new Error("stale writer unexpectedly accepted");
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      outcome = {
        kind: "fenced",
        version,
        expected: error.expectedVersion,
        actual: error.actualVersion,
        state: await store.load(),
      };
    }
  } else if (action === "fenced-delete") {
    const store = doStore(storage, (raw) => counter.parse(raw), {
      key: "tx/fenced",
      fenced: true,
    });
    const oldOwner = await store.loadFenced();
    await store.delete();
    const deleted = await store.loadFenced();
    try {
      await store.saveFenced({ count: 200 }, oldOwner.version);
      throw new Error("deleted store unexpectedly accepted old owner");
    } catch (error) {
      if (!(error instanceof StoreConflictError)) throw error;
      outcome = {
        kind: "fenced-delete",
        deleted_version: deleted.version,
        deleted_state: deleted.raw,
        expected: error.expectedVersion,
        actual: error.actualVersion,
        state: await store.load(),
      };
    }
  } else if (action === "delete") {
    await storage.transaction(async (txn) => {
      await txn.delete(["tx/commit/a", "tx/commit/b", "tx/commit/u"]);
    });
    outcome = { kind: "delete" };
  }
  await storage.sync();
  const cells = [...(await storage.list({ prefix: "tx/" }))];
  return Response.json({ outcome, cells });
}
