import { type Cmd, defineMachine, run } from "@demlik/tea";
import { debounce } from "@demlik/tea/debounce";

type Phase = "idle" | "typing" | "searching" | "results";

interface State {
  phase: Phase;
  query: string;
  committedQuery: string | null;
  hits: readonly string[];
  searchCount: number;
}

type Msg =
  | { type: "query_changed"; query: string }
  | { type: "search_window_settled"; query: string }
  | { type: "search_ok"; query: string; hits: readonly string[] }
  | { type: "drain" };

type DoSearch = Cmd<"do_search"> & { query: string };

type Sub = never;

interface Ctx {
  search: (query: string) => Promise<readonly string[]>;
}

export const debouncedSearch = defineMachine<State, Msg, DoSearch, Sub, Ctx>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [
          {
            phase: "idle",
            query: "",
            committedQuery: null,
            hits: [],
            searchCount: 0,
          },
          [],
        ],

  update: {
    query_changed: (s, m) => [{ ...s, phase: "typing", query: m.query }, []],

    search_window_settled: (s, m) => [
      { ...s, phase: "searching", committedQuery: m.query },
      [{ type: "do_search", query: m.query }],
    ],

    search_ok: (s, m) =>
      m.query === s.committedQuery
        ? [
            {
              ...s,
              phase: "results",
              hits: m.hits,
              searchCount: s.searchCount + 1,
            },
            [],
          ]
        : [s, []],

    drain: (s) => [s, []],
  },

  interpret: {
    do_search: async (cmd, ctx) => {
      const hits = await ctx.search(cmd.query);
      return { type: "search_ok", query: cmd.query, hits };
    },
  },
});

const CORPUS = [
  "terraform the durable object",
  "terraform azeroth biome",
  "terraform pipeline lexer",
  "tea substrate invariants",
  "tea debounce coalesce burst",
];

function fakeSearch(searchLog: string[]): Ctx["search"] {
  return (query) => {
    searchLog.push(query);
    const q = query.toLowerCase();
    const hits = CORPUS.filter((row) => row.includes(q));
    return Promise.resolve(hits);
  };
}

async function main(): Promise<void> {
  const searchLog: string[] = [];
  const runtime = run(debouncedSearch, {
    ctx: { search: fakeSearch(searchLog) },
  });
  await runtime.ready;

  const QUIET_MS = 200;
  const fireSettled = debounce((query: string) => {
    void runtime.dispatch({ type: "search_window_settled", query });
  }, QUIET_MS);

  const burst = ["t", "te", "ter", "terraform"];

  console.log("user types a burst; each keystroke arms the debounce window\n");
  for (const query of burst) {
    await runtime.dispatch({ type: "query_changed", query });
    fireSettled(query);
    console.log(
      `keystroke "${query}"  phase=${runtime.getState().phase}  searchesSoFar=${searchLog.length}`,
    );
  }

  console.log(
    "\nfour keystrokes landed, zero searches fired — the burst coalesced",
  );
  console.log("quiet window elapses; the debounce releases ONE settled Msg\n");

  fireSettled.flush();
  await runtime.dispatch({ type: "drain" });
  await runtime.dispatch({ type: "drain" });

  const final = runtime.getState();
  console.log(`committedQuery   ${JSON.stringify(final.committedQuery)}`);
  console.log(`searchCount      ${final.searchCount}`);
  console.log(`searchLog        ${JSON.stringify(searchLog)}`);
  console.log(`hits`);
  for (const hit of final.hits) {
    console.log(`  - ${hit}`);
  }

  const exactlyOne = searchLog.length === 1 && searchLog[0] === "terraform";
  console.log(
    `\nexactly one search ran, for the final query: ${exactlyOne ? "yes" : "no"}`,
  );

  await runtime.stop();
}

main();
