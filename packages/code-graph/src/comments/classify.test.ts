import { describe, expect, it } from "vitest";
import {
  bucketRecord,
  bucketsIn,
  COMMENT_BUCKETS,
  type CommentBucket,
  classifyComment,
  classOf,
  commentBody,
} from "./classify.js";

function bucketOf(text: string, pos = 100, fileHeaderCandidate = false): CommentBucket {
  return classifyComment({ text, pos, fileHeaderCandidate });
}

describe("commentBody", () => {
  it("strips line and block delimiters and continuation stars", () => {
    expect(commentBody("//  hello ")).toBe("hello");
    expect(commentBody("/* hello */")).toBe("hello");
    expect(commentBody("/**\n * one\n * two\n */")).toBe("one\ntwo");
  });
});

describe("the protected class wins over everything it overlaps", () => {
  it("recognizes the pragmas that change what the build does", () => {
    expect(bucketOf("// @ts-expect-error narrowing")).toBe("pragma");
    expect(bucketOf("// biome-ignore lint/suspicious/noExplicitAny: boundary")).toBe("pragma");
    expect(bucketOf("// eslint-disable-next-line")).toBe("pragma");
    expect(bucketOf("/* c8 ignore next */")).toBe("pragma");
    expect(bucketOf("/// <reference types='node' />")).toBe("pragma");
  });

  it("recognizes a license only at file position 0", () => {
    expect(bucketOf("// Copyright 2026 Binclusive", 0)).toBe("license");
    expect(bucketOf("// SPDX-License-Identifier: Apache-2.0", 0)).toBe("license");
    expect(bucketOf("// Copyright 2026 Binclusive", 500)).toBe("inline");
  });

  it("protects a marker even inside what would otherwise be prose", () => {
    expect(bucketOf("/** TODO: collapse this with the other one */")).toBe("marker");
    expect(bucketOf("// FIXME later")).toBe("marker");
    expect(bucketOf("/** @deprecated use `next()` */")).toBe("marker");
    expect(bucketOf("// @ts-ignore TODO drop this")).toBe("pragma");
  });
});

describe("commented-out code", () => {
  it("accepts a body the parser accepts as real TypeScript", () => {
    expect(bucketOf("// const x = 1;")).toBe("commented-out-code");
    expect(bucketOf("// return null;")).toBe("commented-out-code");
    expect(bucketOf("// import { a } from './a.js';")).toBe("commented-out-code");
    expect(bucketOf("// <Button disabled />")).toBe("commented-out-code");
    expect(bucketOf("/* export type X = { a: string };*/")).toBe("commented-out-code");
  });

  it("rejects prose that merely ends like a statement", () => {
    expect(bucketOf("// a note, with a trailing comma,")).toBe("inline");
    expect(bucketOf("// see resolveThresholds(opts.thresholds, cleanExit)")).toBe("inline");
    expect(bucketOf("// this is ordinary prose")).toBe("inline");
  });

  it("rejects a lone identifier or string — it parses, but it is prose", () => {
    expect(bucketOf("// resolveThresholds")).toBe("inline");
    expect(bucketOf('// "danger"')).toBe("inline");
  });

  it("does not misread a regex literal the way an unparsed scan would", () => {
    expect(bucketOf("// const slash = /a\\/\\/b/;")).toBe("commented-out-code");
  });
});

describe("banners", () => {
  it("recognizes rules and wrapped dividers", () => {
    expect(bucketOf("// ----------")).toBe("banner");
    expect(bucketOf("// ==========")).toBe("banner");
    expect(bucketOf("// ---- Types ----")).toBe("banner");
    expect(bucketOf("// ### section")).toBe("banner");
  });

  it("leaves an empty comment as an ordinary inline one", () => {
    expect(bucketOf("//")).toBe("inline");
  });
});

describe("block-comment buckets", () => {
  it("routes the one file-header candidate, then docblock vs block", () => {
    expect(bucketOf("/**\n * header essay\n */", 40, true)).toBe("file-header");
    expect(bucketOf("/**\n * header essay\n */", 40, false)).toBe("docblock");
    expect(bucketOf("/* a plain block */")).toBe("block");
    expect(bucketOf("// not a block", 40, true)).toBe("inline");
  });
});

describe("the bucket set is one list", () => {
  it("partitions into three classes with nothing shared and nothing left over", () => {
    expect(bucketsIn("protected")).toEqual(["pragma", "license", "marker"]);
    expect(bucketsIn("mechanical")).toEqual(["commented-out-code", "banner"]);
    expect(bucketsIn("prose")).toEqual(["file-header", "docblock", "block", "inline"]);

    const partitioned = [
      ...bucketsIn("protected"),
      ...bucketsIn("mechanical"),
      ...bucketsIn("prose"),
    ];
    expect([...partitioned].sort()).toEqual([...COMMENT_BUCKETS].sort());
  });

  it("gives every bucket exactly one class", () => {
    for (const bucket of COMMENT_BUCKETS) {
      expect(bucketsIn(classOf(bucket))).toContain(bucket);
    }
  });

  it("builds a record with exactly one entry per bucket", () => {
    expect(Object.keys(bucketRecord(() => 0)).sort()).toEqual([...COMMENT_BUCKETS].sort());
  });
});
