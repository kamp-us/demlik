import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  type IssueAddress,
  type PullRelation,
  pullRelation,
} from "./relation.js";

const RepositoryRef = z.object({ nameWithOwner: z.string() });

const PullRef = z.object({
  __typename: z.literal("PullRequest"),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  repository: RepositoryRef,
  closingIssuesReferences: z.object({
    nodes: z.array(z.object({ number: z.number(), repository: RepositoryRef })),
  }),
});

const IssueRef = z.object({
  __typename: z.literal("Issue"),
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable(),
});

const TimelineNode = z.union([
  z.object({
    __typename: z.literal("CrossReferencedEvent"),
    source: z.union([PullRef, IssueRef]),
  }),
  z.object({
    __typename: z.literal("ConnectedEvent"),
    subject: z.union([PullRef, IssueRef]),
  }),
  z.object({ __typename: z.string() }),
]);

const IssueNode = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  comments: z.object({
    nodes: z.array(
      z.object({
        body: z.string(),
        createdAt: z.string(),
        author: z.object({ login: z.string() }).nullable(),
      }),
    ),
  }),
  timelineItems: z.object({ nodes: z.array(TimelineNode) }),
});

const IssuePage = z.object({
  data: z.object({
    repository: z.object({
      issues: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
        nodes: z.array(IssueNode),
      }),
    }),
  }),
});

const ClosedIssue = z.object({
  number: z.number(),
  title: z.string(),
  stateReason: z.string().nullable().optional(),
});

/** A linked pull request as the evidence states it; `closed-unmerged` was closed without merging. */
export interface LinkedPull {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed-unmerged";
  readonly relation: PullRelation;
}

const PULL_STATE = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed-unmerged",
} as const satisfies Record<
  z.infer<typeof PullRef>["state"],
  LinkedPull["state"]
>;

export type LinkedIssue = z.infer<typeof IssueRef>;

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly comments: readonly {
    readonly author: string;
    readonly body: string;
  }[];
  readonly linkedPulls: readonly LinkedPull[];
  readonly linkedIssues: readonly LinkedIssue[];
}

export type ClosedIssue = z.infer<typeof ClosedIssue>;

const ISSUES_QUERY = `
fragment LinkedPull on PullRequest {
  number title body state
  repository { nameWithOwner }
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
}

query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 40, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url createdAt updatedAt
        labels(first: 20) { nodes { name } }
        comments(last: 3) { nodes { body createdAt author { login } } }
        timelineItems(last: 40, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
          nodes {
            __typename
            ... on CrossReferencedEvent {
              source {
                __typename
                ... on PullRequest { ...LinkedPull }
                ... on Issue { number title state stateReason }
              }
            }
            ... on ConnectedEvent {
              subject {
                __typename
                ... on PullRequest { ...LinkedPull }
                ... on Issue { number title state stateReason }
              }
            }
          }
        }
      }
    }
  }
}`;

function gh(args: readonly string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The pull requests and issues a timeline links, each pull request with its relation to `issue`. */
function linksOf(
  nodes: readonly z.infer<typeof TimelineNode>[],
  issue: IssueAddress,
) {
  const pulls = new Map<number, LinkedPull>();
  const issues = new Map<number, LinkedIssue>();
  for (const node of nodes) {
    const ref =
      "source" in node
        ? node.source
        : "subject" in node
          ? node.subject
          : undefined;
    if (ref === undefined) continue;
    if (ref.__typename === "PullRequest") {
      pulls.set(ref.number, {
        number: ref.number,
        title: ref.title,
        state: PULL_STATE[ref.state],
        relation: pullRelation(
          {
            repository: ref.repository.nameWithOwner,
            body: ref.body,
            closingIssuesReferences: ref.closingIssuesReferences.nodes.map(
              (c) => ({
                number: c.number,
                repository: c.repository.nameWithOwner,
              }),
            ),
          },
          issue,
        ),
      });
    } else issues.set(ref.number, ref);
  }
  return {
    linkedPulls: [...pulls.values()],
    linkedIssues: [...issues.values()],
  };
}

export function fetchOpenIssues(owner: string, name: string): OpenIssue[] {
  const issues: OpenIssue[] = [];
  let after: string | null = null;
  do {
    const args: string[] = [
      "api",
      "graphql",
      "-f",
      `query=${ISSUES_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      ...(after === null ? [] : ["-F", `after=${after}`]),
    ];
    const page: z.infer<typeof IssuePage>["data"]["repository"]["issues"] =
      IssuePage.parse(JSON.parse(gh(args))).data.repository.issues;
    for (const node of page.nodes) {
      issues.push({
        number: node.number,
        title: node.title,
        body: node.body,
        url: node.url,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        labels: node.labels.nodes.map((l) => l.name),
        comments: node.comments.nodes.map((c) => ({
          author: c.author?.login ?? "ghost",
          body: c.body,
        })),
        ...linksOf(node.timelineItems.nodes, {
          number: node.number,
          repository: `${owner}/${name}`,
        }),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return issues;
}

export function fetchClosedIssues(repo: string): ClosedIssue[] {
  const raw = gh([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "closed",
    "--limit",
    "10000",
    "--json",
    "number,title,stateReason",
  ]);
  return z.array(ClosedIssue).parse(JSON.parse(raw));
}
