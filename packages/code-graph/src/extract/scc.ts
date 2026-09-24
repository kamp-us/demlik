type Frame = { node: string; i: number };

type TarjanState = {
  index: Map<string, number>;
  low: Map<string, number>;
  onStack: Set<string>;
  stack: string[];
  sccOf: Map<string, number>;
  work: Frame[];
  counter: number;
  sccCount: number;
};

function discover(st: TarjanState, node: string): void {
  st.index.set(node, st.counter);
  st.low.set(node, st.counter);
  st.counter += 1;
  st.stack.push(node);
  st.onStack.add(node);
}

function advanceFrame(st: TarjanState, frame: Frame, neighbors: string[]): boolean {
  if (frame.i >= neighbors.length) return false;
  const next = neighbors[frame.i];
  frame.i += 1;
  if (next === undefined) return true;
  if (!st.index.has(next)) {
    discover(st, next);
    st.work.push({ node: next, i: 0 });
  } else if (st.onStack.has(next)) {
    st.low.set(frame.node, Math.min(st.low.get(frame.node) ?? 0, st.index.get(next) ?? 0));
  }
  return true;
}

function closeFrame(st: TarjanState, frame: Frame): void {
  if ((st.low.get(frame.node) ?? 0) === (st.index.get(frame.node) ?? 0)) {
    for (;;) {
      const w = st.stack.pop();
      if (w === undefined) break;
      st.onStack.delete(w);
      st.sccOf.set(w, st.sccCount);
      if (w === frame.node) break;
    }
    st.sccCount += 1;
  }
  st.work.pop();
  const parent = st.work[st.work.length - 1];
  if (parent) {
    st.low.set(parent.node, Math.min(st.low.get(parent.node) ?? 0, st.low.get(frame.node) ?? 0));
  }
}

export function stronglyConnectedComponents(
  nodes: string[],
  adj: Map<string, string[]>,
): Map<string, number> {
  const st: TarjanState = {
    index: new Map(),
    low: new Map(),
    onStack: new Set(),
    stack: [],
    sccOf: new Map(),
    work: [],
    counter: 0,
    sccCount: 0,
  };

  for (const start of nodes) {
    if (st.index.has(start)) continue;
    discover(st, start);
    st.work = [{ node: start, i: 0 }];
    while (st.work.length > 0) {
      const frame = st.work[st.work.length - 1];
      if (!frame) break;
      const neighbors = adj.get(frame.node) ?? [];
      if (!advanceFrame(st, frame, neighbors)) closeFrame(st, frame);
    }
  }
  return st.sccOf;
}

export function sccMembers(nodes: string[], sccOf: Map<string, number>): Map<number, string[]> {
  const members = new Map<number, string[]>();
  for (const n of nodes) {
    const s = sccOf.get(n);
    if (s === undefined) continue;
    const arr = members.get(s) ?? [];
    arr.push(n);
    members.set(s, arr);
  }
  return members;
}
