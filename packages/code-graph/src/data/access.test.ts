import { describe, expect, it } from "vitest";
import { accessOf, sqlAccess } from "./access.js";

describe("sqlAccess: a D1 statement's leading keyword", () => {
  it.each([
    ["SELECT * FROM t", "read"],
    ["  select id from t", "read"],
    ["INSERT INTO t VALUES (?)", "write"],
    ["update t set a = ?", "write"],
    ["DELETE FROM t", "write"],
    ["CREATE TABLE t (id)", "write"],
    ["WITH x AS (SELECT 1) SELECT * FROM x", "unknown"],
    ["PRAGMA table_list", "unknown"],
    ["", "unknown"],
  ] as const)("%j is %s", (sql, access) => {
    expect(sqlAccess(sql)).toBe(access);
  });

  it("is unknown when the SQL is not a literal at the call site", () => {
    expect(sqlAccess(null)).toBe("unknown");
  });
});

describe("accessOf: the method called on a binding", () => {
  it.each([
    ["kv", "get", "read"],
    ["kv", "list", "read"],
    ["kv", "put", "write"],
    ["kv", "delete", "write"],
    ["r2", "head", "read"],
    ["r2", "put", "write"],
    ["r2", "createMultipartUpload", "write"],
    ["queue", "send", "write"],
    ["queue", "sendBatch", "write"],
    ["durable-object", "get", "unknown"],
    ["durable-object", "idFromName", "unknown"],
    ["d1", "dump", "read"],
    ["d1", "batch", "unknown"],
    ["kv", "somethingNew", "unknown"],
  ] as const)("%s.%s() is %s", (kind, method, access) => {
    expect(accessOf(kind, method, null)).toBe(access);
  });

  it("reads D1 prepare and exec through their SQL", () => {
    expect(accessOf("d1", "prepare", "SELECT 1")).toBe("read");
    expect(accessOf("d1", "exec", "DROP TABLE t")).toBe("write");
  });

  it("is unknown when the binding is handed on whole", () => {
    expect(accessOf("kv", null, null)).toBe("unknown");
  });
});
