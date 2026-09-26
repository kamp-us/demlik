import { describe, expect, it } from "vitest";
import { pullRelation, type RelationSource } from "../src/relation.js";

const issue = { number: 12, repository: "acme/widgets" };

const pr = (
  body: string,
  closingIssuesReferences: RelationSource["closingIssuesReferences"] = [],
  repository = "acme/widgets",
): RelationSource => ({ repository, body, closingIssuesReferences });

describe("pullRelation", () => {
  it("reads a pull request that is only part of the issue as partial", () => {
    expect(pullRelation(pr("Part of #12"), issue)).toBe("partial");
  });

  it("reads a cross-reference as partial", () => {
    expect(pullRelation(pr("Refs #12"), issue)).toBe("partial");
  });

  it("reads a closing keyword naming the issue as closes", () => {
    expect(pullRelation(pr("Fixes #12"), issue)).toBe("closes");
    expect(pullRelation(pr("this RESOLVED: #12 for good"), issue)).toBe(
      "closes",
    );
    expect(pullRelation(pr("closes acme/widgets#12"), issue)).toBe("closes");
    expect(
      pullRelation(
        pr("Closed https://github.com/acme/widgets/issues/12"),
        issue,
      ),
    ).toBe("closes");
  });

  it("reads GitHub's closing reference as closes with no keyword in the body", () => {
    expect(
      pullRelation(
        pr("Linked from the sidebar.", [
          { number: 12, repository: "acme/widgets" },
        ]),
        issue,
      ),
    ).toBe("closes");
  });

  it("reads a closing keyword naming a different issue as partial", () => {
    expect(pullRelation(pr("Fixes #120, part of #12"), issue)).toBe("partial");
    expect(pullRelation(pr("Fixes #13"), issue)).toBe("partial");
  });

  it("does not match the issue number in another repository", () => {
    expect(pullRelation(pr("Fixes other/repo#12"), issue)).toBe("partial");
    expect(pullRelation(pr("Fixes #12", [], "other/repo"), issue)).toBe(
      "partial",
    );
    expect(
      pullRelation(pr("", [{ number: 12, repository: "other/repo" }]), issue),
    ).toBe("partial");
  });

  it("does not read a keyword inside another word", () => {
    expect(pullRelation(pr("prefixes #12"), issue)).toBe("partial");
  });
});
