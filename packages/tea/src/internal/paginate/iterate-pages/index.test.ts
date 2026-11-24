import { describe, expect, it, vi } from "vitest";
import { iteratePages } from "./index";

type Page = { readonly items: readonly string[]; readonly next: number | null };

function pagesAt(pages: Record<number, Page>) {
  return vi.fn(async (cursor: number) => {
    const page = pages[cursor];
    if (!page) throw new Error(`no page at ${cursor}`);
    return page;
  });
}

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

describe("iteratePages", () => {
  it("fetches nothing until the first pull", async () => {
    const fetchPage = pagesAt({ 0: { items: ["a"], next: null } });
    const pages = iteratePages({
      firstCursor: 0,
      fetchPage,
      nextCursor: (page) => page.next,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    await expect(pages.next()).resolves.toEqual({
      done: false,
      value: { items: ["a"], next: null },
    });
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("ends after the page whose next cursor is null or undefined", async () => {
    for (const end of [null, undefined]) {
      const terminal = { items: ["a"], next: end };
      const fetchPage = vi.fn(async () => terminal);
      const pages = await collect(
        iteratePages({
          firstCursor: "first",
          fetchPage,
          nextCursor: (page) => page.next,
        }),
      );
      expect(pages).toEqual([terminal]);
      expect(fetchPage).toHaveBeenCalledOnce();
    }
  });

  it("yields an empty page unchanged and follows its cursor", async () => {
    const empty: Page = { items: [], next: 1 };
    const last: Page = { items: ["b"], next: null };
    const pages = await collect(
      iteratePages({
        firstCursor: 0,
        fetchPage: pagesAt({ 0: empty, 1: last }),
        nextCursor: (page) => page.next,
      }),
    );
    expect(pages[0]).toBe(empty);
    expect(pages[1]).toBe(last);
  });

  it("passes each opaque cursor through unchanged, including 0 and the empty string", async () => {
    const cursors = ["", 0, { after: "row_9" }] as const;
    const fetchPage = vi.fn(async (cursor: (typeof cursors)[number]) => cursor);
    const pages = await collect(
      iteratePages<(typeof cursors)[number], (typeof cursors)[number]>({
        firstCursor: cursors[0],
        fetchPage,
        nextCursor: (page) => cursors[cursors.indexOf(page) + 1],
      }),
    );
    expect(pages).toEqual(cursors);
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual(cursors);
    expect(fetchPage.mock.calls[2]?.[0]).toBe(cursors[2]);
  });

  it("fetches no page while the consumer is still working on the last one", async () => {
    const fetchPage = pagesAt({
      0: { items: ["a"], next: 1 },
      1: { items: ["b"], next: null },
    });
    let release = () => {};
    const working = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const walked = (async () => {
      for await (const page of iteratePages({
        firstCursor: 0,
        fetchPage,
        nextCursor: (page) => page.next,
      })) {
        seen.push(...page.items);
        if (page.next !== null) await working;
      }
    })();
    await vi.waitFor(() => expect(seen).toEqual(["a"]));
    await Promise.resolve();
    expect(fetchPage).toHaveBeenCalledOnce();
    release();
    await walked;
    expect(seen).toEqual(["a", "b"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("returns early without reading the continuation", async () => {
    const fetchPage = pagesAt({ 0: { items: ["a"], next: 1 } });
    const nextCursor = vi.fn((page: Page) => page.next);
    for await (const page of iteratePages({
      firstCursor: 0,
      fetchPage,
      nextCursor,
    })) {
      expect(page.items).toEqual(["a"]);
      break;
    }
    expect(nextCursor).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("rejects with the fetch's own failure", async () => {
    const cause = new Error("page 1 is down");
    const fetchPage = vi
      .fn<(cursor: number) => Promise<Page>>()
      .mockResolvedValueOnce({ items: ["a"], next: 1 })
      .mockRejectedValueOnce(cause);
    const seen: Page[] = [];
    await expect(
      (async () => {
        for await (const page of iteratePages({
          firstCursor: 0,
          fetchPage,
          nextCursor: (page) => page.next,
        }))
          seen.push(page);
      })(),
    ).rejects.toBe(cause);
    expect(seen).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
