// A write the table kinds cannot attribute to a table, by why. One row per kind: the label a
// report prints, and whether the file's own syntax shows it (`syntax`) or only following a chain of
// re-exports does. B23 and the owners view stay silent about these writes; the census and the
// view's `Not followed` block name them, so a gate that is green is never green by being blind.
export const UNFOLLOWED = {
  // `db.insert(t)` where `t` is no import the file binds once: a variable, a parameter, a helper's
  // result, a spread, a member of a value the file got elsewhere.
  "untraced-write": { label: "write whose table is not an import", syntax: true },
  // The table's name is imported from a module the run did not load, or a chain of re-exports ends
  // at one (a barrel that re-exports a workspace package, an alias only another tsconfig resolves).
  "unloaded-module": {
    label: "write whose table comes from a module the run did not load",
    syntax: false,
  },
  // Defaults are not followed: `import t from`, `export { default as t } from`, `export default`.
  "default-export": { label: "write whose table is a default export", syntax: false },
  // Two `export *` supply one name, which ECMAScript calls ambiguous: the run does not guess.
  "ambiguous-star": { label: "write whose table two export * both supply", syntax: false },
  // A module that exports with `export =` has no named exports to follow.
  "export-equals": { label: "write whose table comes through an export = module", syntax: false },
  // A string or template that starts as an `insert into`, `update … set` or `delete from`.
  "raw-sql": { label: "raw SQL that writes", syntax: true },
} as const satisfies Record<string, { label: string; syntax: boolean }>;

export type UnfollowedKind = keyof typeof UNFOLLOWED;

export const UNFOLLOWED_KINDS = Object.keys(UNFOLLOWED) as UnfollowedKind[];

// The kinds a file's own syntax shows, read in `tableFactsOf`.
export type SyntaxUnfollowed = {
  [K in UnfollowedKind]: (typeof UNFOLLOWED)[K]["syntax"] extends true ? K : never;
}[UnfollowedKind];

export const SYNTAX_UNFOLLOWED = UNFOLLOWED_KINDS.filter(
  (kind): kind is SyntaxUnfollowed => UNFOLLOWED[kind].syntax,
);

// A file the run could not follow a write in, and the kind. `file` is repo-relative. One row per
// file per kind, however many writes it holds.
export type NotFollowed = { readonly file: string; readonly kind: UnfollowedKind };

export function compareNotFollowed(a: NotFollowed, b: NotFollowed): number {
  return (
    a.file.localeCompare(b.file) ||
    UNFOLLOWED_KINDS.indexOf(a.kind) - UNFOLLOWED_KINDS.indexOf(b.kind)
  );
}

export const notFollowedLine = ({ file, kind }: NotFollowed): string =>
  `${file}  ${kind}  ${UNFOLLOWED[kind].label}`;
