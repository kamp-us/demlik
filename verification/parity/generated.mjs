import assert from "node:assert/strict";

export function generatedCases(seed = 0x5eed1234) {
  let state = seed >>> 0;
  function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  }
  const pick = (values) => values[Math.floor(random() * values.length)];
  const cases = [];
  for (let index = 0; index < 500; index++) {
    cases.push({
      id: `generated.retry.${seed}.${index}`,
      operation: "tea.retry.backoff",
      input: {
        attempt: pick([-4, -0.5, 0, 0.5, 1, 1.5, 2, 3, 8, 25, 1024]),
        curve: {
          baseMs: pick([0, 0.1, 1, 10, 100, 1024, 5e-324]),
          factor: pick([-2, -1, 0, 0.1, 0.5, 1, 2, 4, 10]),
          capMs: pick([0, 1, 25, 500, 1e9]),
          jitter: pick(["none", "full", "equal"]),
        },
        random: [random()],
      },
    });
  }
  for (let index = 0; index < 300; index++) {
    const nodes = Array.from(
      { length: Math.floor(random() * 13) },
      (_, i) => `n${i}`,
    );
    for (let i = nodes.length - 1; i > 0; i--) {
      const other = Math.floor(random() * (i + 1));
      [nodes[i], nodes[other]] = [nodes[other], nodes[i]];
    }
    const targets = [...nodes, "external"];
    const adjacency = {};
    for (const node of targets) {
      adjacency[node] = targets.filter(() => random() < 0.18);
      if (adjacency[node].length && random() < 0.2)
        adjacency[node].push(adjacency[node][0]);
    }
    for (const operation of ["code_graph.scc", "code_graph.scc_members"]) {
      cases.push({
        id: `generated.${operation}.${seed}.${index}`,
        operation,
        input: { nodes, adjacency },
      });
    }
  }
  const nodes = Array.from({ length: 20_000 }, (_, i) => `chain${i}`);
  const adjacency = Object.fromEntries(
    nodes.map((node, i) => [node, i + 1 < nodes.length ? [nodes[i + 1]] : []]),
  );
  cases.push({
    id: "scale.scc-20000-node-chain",
    operation: "code_graph.scc",
    input: { nodes, adjacency },
  });
  return cases;
}

function reachable(start, adjacency) {
  const found = new Set([start]);
  const pending = [start];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of adjacency[node] ?? []) {
      if (!found.has(target)) {
        found.add(target);
        pending.push(target);
      }
    }
  }
  return found;
}

export function checkGraphContract(input, output) {
  const components = new Map(output.components);
  assert.equal(
    components.size,
    output.components.length,
    "each discovered node occurs once",
  );
  const found = new Set(input.nodes);
  const pending = [...found];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of input.adjacency[node] ?? []) {
      if (!found.has(target)) {
        found.add(target);
        pending.push(target);
      }
    }
  }
  assert.deepStrictEqual(
    new Set(components.keys()),
    found,
    "the result covers precisely the reachable nodes",
  );
  const ids = [...new Set(components.values())].sort((a, b) => a - b);
  assert.deepStrictEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => i),
    "component IDs are contiguous from zero",
  );
  for (const [node, component] of components) {
    for (const target of input.adjacency[node] ?? []) {
      if (components.get(target) !== component)
        assert.ok(
          components.get(target) < component,
          "dependency components close before their callers",
        );
    }
  }
  if (found.size <= 64) {
    const reach = new Map(
      [...found].map((node) => [node, reachable(node, input.adjacency)]),
    );
    for (const a of found) {
      for (const b of found) {
        assert.equal(
          components.get(a) === components.get(b),
          reach.get(a).has(b) && reach.get(b).has(a),
          "nodes share a component exactly when mutually reachable",
        );
      }
    }
  }
}
