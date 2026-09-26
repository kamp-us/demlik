/**
 * Whether a linked pull request closes an issue or only references it — a fact read off GitHub,
 * never asked of Jev. A "Part of #N" pull request merges without finishing the issue, so only this
 * relation, not the pull request's merged state, can back a close.
 */
export type PullRelation = "closes" | "partial";

/** A pull request as the relation reads it: the repository it lives in, its body, and what GitHub says it closes. */
export interface RelationSource {
  readonly repository: string;
  readonly body: string;
  readonly closingIssuesReferences: readonly {
    readonly number: number;
    readonly repository: string;
  }[];
}

/** The issue the relation is judged against. */
export interface IssueAddress {
  readonly number: number;
  readonly repository: string;
}

const CLOSING_KEYWORD =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?:([\w.-]+\/[\w.-]+))?#(\d+))\b/gi;

const sameRepository = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

/** The issues a pull request body closes by keyword, each resolved to the repository it names. */
function closedByKeyword(
  body: string,
  repository: string,
): readonly IssueAddress[] {
  const closed: IssueAddress[] = [];
  for (const match of body.matchAll(CLOSING_KEYWORD)) {
    const [, urlRepo, urlNumber, refRepo, refNumber] = match;
    closed.push({
      repository: urlRepo ?? refRepo ?? repository,
      number: Number(urlNumber ?? refNumber),
    });
  }
  return closed;
}

/**
 * `closes` when GitHub lists the issue in the pull request's `closingIssuesReferences`, else when
 * the body carries a closing keyword directly followed by a reference to the issue, else `partial`.
 * A bare `#N` in the body names an issue in the pull request's own repository.
 */
export function pullRelation(
  pull: RelationSource,
  issue: IssueAddress,
): PullRelation {
  const names = (ref: IssueAddress) =>
    ref.number === issue.number &&
    sameRepository(ref.repository, issue.repository);
  if (pull.closingIssuesReferences.some(names)) return "closes";
  if (closedByKeyword(pull.body, pull.repository).some(names)) return "closes";
  return "partial";
}
