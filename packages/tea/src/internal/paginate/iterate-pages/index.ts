import {
  initPaginator,
  type PaginatorPolicy,
  recordPage,
  start,
} from "../paginator";

/**
 * The page iterator's config. Generic in `Cursor` (the opaque page handle the
 * API hands back) and `Page` (the shape `fetchPage` resolves with).
 *
 *   - `firstCursor` — the cursor the first fetch reads, passed through unchanged.
 *   - `fetchPage(cursor)` — fetches one page. A rejection reaches the consumer's
 *     `for await` unchanged.
 *   - `nextCursor(page)` — the API's next-page handle, or `null` / `undefined`
 *     at the end. Any other value (including `0` and `""`) is fetched next.
 */
export interface IteratePagesConfig<Cursor, Page> {
  readonly firstCursor: Cursor;
  readonly fetchPage: (cursor: Cursor) => Promise<Page>;
  readonly nextCursor: (page: Page) => Cursor | null | undefined;
}

/**
 * Walk a paginated API as a pull-driven async iterator that yields each page
 * unchanged — the shape of the AWS SDK v3 paginators.
 *
 * It interprets the paginator ops: `start` arms `firstCursor`, and
 * `recordPage` folds each page's next cursor into the walk. Backpressure is
 * off, because the consumer's pull already decides when the next page is
 * fetched: nothing is fetched before the first `next()`, and the following
 * page is fetched only after the consumer's loop body for this one has
 * finished.
 *
 * The page is yielded before `nextCursor` reads it, so a consumer that breaks
 * or returns out of its `for await` ends the walk without extracting a
 * continuation. It retains one page; collecting, retrying, capping and
 * unwrapping results are the consumer's.
 */
export async function* iteratePages<Cursor, Page>(
  config: IteratePagesConfig<Cursor, Page>,
): AsyncGenerator<Page, void, undefined> {
  const policy: PaginatorPolicy<Cursor> = {
    firstCursor: config.firstCursor,
    highWaterMark: 0,
  };
  let walk = start(initPaginator<Cursor>(), policy);
  while (walk.phase === "fetching") {
    const page = await config.fetchPage(walk.cursor);
    yield page;
    walk = recordPage(walk, 0, config.nextCursor(page), policy);
  }
}
