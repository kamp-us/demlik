import assert from "node:assert/strict";
import {
  createPaginatedWalk,
  type PageOkMsg,
} from "../../packages/tea/src/internal/paginate/paginated-walk/index.ts";

function typedConsumer() {
  const walk = createPaginatedWalk<
    { token: string },
    { rows: number[]; next: { token: string } | null },
    { type: "rows"; rows: number[] }
  >({
    firstPage: { token: "first" },
    nextCursor: (page) => page.next,
    onPage: (page) => [{ type: "rows", rows: page.rows }],
  });
  const command = walk.fetch({ key: "page", input: { token: "first" } });
  const completion = walk.fetch.ok(command, { rows: [1], next: null }, 17.25);
  walk.pageOk(walk.init(), completion);
  // @ts-expect-error the fetch keeps the caller's precise cursor
  walk.fetch({ key: "page", input: 42 });
  // @ts-expect-error the page success keeps its declared row type
  walk.fetch.ok(command, { rows: ["wrong"], next: null }, 1);
  const wrongPage: PageOkMsg<number> = {
    type: "resilient_run_ok",
    cmd: command,
    value: 42,
    at: 1,
  };
  // @ts-expect-error a differently typed page cannot advance this walk
  walk.pageOk(walk.init(), wrongPage);
}
void typedConsumer;

// The same onPage function can synchronously reenter itself. Neither caller nor
// knob changes the function identity or skips the nested invocation.
const page = { next: null };
let calls = 0;
const onPage = (value: typeof page) => {
  assert.equal(value, page);
  calls++;
  if (calls === 1) walk.pageOk(started, walk.fetch.ok(command, value, 1));
  return [];
};
const walk = createPaginatedWalk({
  firstPage: 0,
  nextCursor: (value: typeof page) => value.next,
  onPage,
});
const [started, commands] = walk.start(walk.init(), 0);
assert.equal(commands.length, 1);
const command = walk.fetch({ key: "page", input: 0 });
const [done] = walk.pageOk(started, walk.fetch.ok(command, page, 1));
assert.equal(calls, 2);
assert.equal(done.walk.phase, "done");
assert.equal(done.walk.pages, 1);
assert.equal(started.walk.phase, "fetching");
process.stdout.write(
  `${JSON.stringify({ reentrantCalls: calls, complete: walk.isComplete(done), originalFetching: started.walk.phase === "fetching" })}\n`,
);
