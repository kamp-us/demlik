import type { DataAccess, DataBindingKind } from "../schema.js";

type MethodTable = { readonly read: ReadonlySet<string>; readonly write: ReadonlySet<string> };

// The Workers runtime API per binding kind. A method in neither set is `unknown`, and so is every
// Durable Object namespace method: `get`/`idFromName` hand back a stub, and what the stub does
// next is not at this call site.
const METHODS: Readonly<Record<Exclude<DataBindingKind, "d1">, MethodTable>> = {
  kv: {
    read: new Set(["get", "getWithMetadata", "list"]),
    write: new Set(["put", "delete"]),
  },
  r2: {
    read: new Set(["get", "head", "list"]),
    write: new Set(["put", "delete", "createMultipartUpload", "resumeMultipartUpload"]),
  },
  queue: { read: new Set(), write: new Set(["send", "sendBatch"]) },
  "durable-object": { read: new Set(), write: new Set() },
};

const SQL_WRITES = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER"]);

// A D1 statement's leading keyword, when the SQL is a literal at the call site. `WITH` can lead
// either way, so it stays `unknown` with every other keyword.
export function sqlAccess(sql: string | null): DataAccess {
  const keyword = sql
    ?.trimStart()
    .match(/^[A-Za-z]+/)?.[0]
    ?.toUpperCase();
  if (keyword === undefined) return "unknown";
  if (keyword === "SELECT") return "read";
  return SQL_WRITES.has(keyword) ? "write" : "unknown";
}

function d1Access(method: string, sql: string | null): DataAccess {
  if (method === "prepare" || method === "exec") return sqlAccess(sql);
  return method === "dump" ? "read" : "unknown";
}

export function accessOf(
  kind: DataBindingKind,
  method: string | null,
  sql: string | null,
): DataAccess {
  if (method === null) return "unknown";
  if (kind === "d1") return d1Access(method, sql);
  const table = METHODS[kind];
  if (table.read.has(method)) return "read";
  return table.write.has(method) ? "write" : "unknown";
}
