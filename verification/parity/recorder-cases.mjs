export function recorderCases() {
  const cases = [],
    add = (id, input) => cases.push({ id: `recorder.${id}`, input }),
    undef = { $undefined: true },
    special = (name) => ({ $number: name }),
    utf16 = (...units) => ({ $utf16: units }),
    object = (...pairs) => ({ $object: pairs }),
    msg = (i) => ({ type: `event${i}`, payload: i }),
    boot = (state) => ({ kind: "boot", state }),
    step = (i, state) => ({ kind: "step", msg: msg(i), state }),
    dump = { kind: "dump" },
    jsonl = { kind: "jsonl" },
    stop = { kind: "stop" };
  for (const captureSteps of [false, true]) {
    for (const [name, sampleRate] of [
      ["default", undefined],
      ["zero", 0],
      ["negative", -1],
      ["nan", special("NaN")],
      ["infinity", special("Infinity")],
      ["above", 2],
      ["half", 0.5],
      ["tiny", Number.MIN_VALUE],
    ])
      add(`record.${name}.${captureSteps}`, {
        op: "record",
        captureSteps,
        ...(sampleRate === undefined ? {} : { sampleRate }),
        rng: [0.1, 0.9, 0.5, special("NaN")],
        actions: [
          dump,
          jsonl,
          boot({ count: 10 }),
          dump,
          step(1, { count: 11 }),
          step(2, { count: 13 }),
          step(3, { count: 16 }),
          step(4, { count: 20 }),
          dump,
          jsonl,
          stop,
          stop,
          step(5, { count: 999 }),
          boot({ count: 888 }),
          dump,
          jsonl,
        ],
      });
    for (const [name, initial, final] of [
      ["null", null, null],
      ["undefined", undef, undef],
      ["undefined-then-value", undef, { count: 1 }],
      ["null-then-value", null, { count: 1 }],
      ["value-then-undefined", { count: 0 }, undef],
      ["nonfinite", special("Infinity"), special("NaN")],
      ["utf16", object([utf16(0xd800), utf16(0xdc00)]), [undef, special("-0")]],
    ])
      add(`record.${name}.${captureSteps}`, {
        op: "record",
        captureSteps,
        actions: [boot(initial), dump, jsonl, step(1, final), dump, jsonl],
      });
    add(`record.no-boot.${captureSteps}`, {
      op: "record",
      captureSteps,
      actions: [
        step(1, { count: 1 }),
        dump,
        jsonl,
        stop,
        step(2, { count: 2 }),
        dump,
      ],
    });
    add(`record.reentrant.${captureSteps}`, {
      op: "record",
      captureSteps,
      sampleRate: 0.5,
      rng: [0.1, 0.1],
      reenter: { msg: msg(2), state: 2 },
      actions: [boot(0), step(1, 1), dump, jsonl],
    });
    add(`record.all-dropped.${captureSteps}`, {
      op: "record",
      captureSteps,
      sampleRate: 0.5,
      rng: [0.9, 0.9],
      actions: [boot(0), step(1, 1), step(2, 2), dump, jsonl],
    });
  }
  const parses = [
    ["empty", ""],
    ["blanks", " \n\r\n\t"],
    ["null", "null"],
    ["unknown-missing", "{}"],
    ["unknown-array", "[]"],
    ["unknown-string", '"boot"'],
    ["unknown-kind", '{"kind":"oops"}'],
    ["unknown-null-kind", '{"kind":null}'],
    ["unknown-object-kind", '{"kind":{"b":2,"a":1}}'],
    ["boot-only", '{"kind":"boot","state":{"count":0}}'],
    ["boot-missing", '{"kind":"boot"}'],
    ["boot-null", '{"kind":"boot","state":null}'],
    ["step-before", '\n{"kind":"step","msg":{"type":"event1"},"state":2}'],
    ["duplicate", '{"kind":"boot","state":0}\n\n{"kind":"boot","state":1}'],
    [
      "null-state-tail",
      '{"kind":"boot","state":0}\n{"kind":"step","msg":{"type":"a"},"state":2}\n{"kind":"step","msg":{"type":"b"},"state":null}',
    ],
    [
      "missing-state-tail",
      '{"kind":"boot","state":0}\n{"kind":"step","msg":{"type":"a"}}',
    ],
    ["missing-msg", '{"kind":"boot","state":0}\n{"kind":"step","state":2}'],
    [
      "sparse",
      '{"kind":"boot","state":0}\n{"kind":"step","msg":{"type":"a"},"state":null}\n{"kind":"step","msg":{"type":"b"},"state":2}\n{"kind":"step","msg":{"type":"c"},"state":null}',
    ],
    [
      "null-boot-step",
      '{"kind":"boot","state":null}\n{"kind":"step","msg":{"type":"a"},"state":2}',
    ],
    [
      "null-boot-null-step",
      '{"kind":"boot","state":null}\n{"kind":"step","msg":1,"state":null}',
    ],
    ["overflow", '{"kind":"boot","state":{"n":1e400,"z":-0}}'],
    ["escaped-utf16", '{"kind":"boot","state":{"\\ud800":"\\udc00"}}'],
    ["syntax", "\n\n{bad}"],
    ["syntax-tail", '{"kind":"boot","state":0}\n{'],
    ["syntax-trailing-comma", '{"kind":"boot","state":[1,]}'],
    ["syntax-control", '{"kind":"boot","state":"\u0000"}'],
  ];
  for (const [name, text] of parses)
    add(`parse.${name}`, { op: "parse", text });
  for (const unit of [
    9, 11, 12, 13, 32, 160, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000, 0xfeff, 0x85, 0x180e, 0x200b,
  ])
    add(`parse.trim-${unit}`, {
      op: "parse",
      text: `${String.fromCharCode(unit)}{"kind":"boot","state":0}${String.fromCharCode(unit)}`,
    });
  for (const surrogate of [0xd800, 0xdc00]) {
    const prefix = Array.from('{"kind":"boot","state":"', (c) =>
        c.charCodeAt(0),
      ),
      suffix = [34, 125];
    for (let slash = 0; slash < 4; slash++)
      add(`parse.literal-${surrogate}-${slash}`, {
        op: "parse",
        text: {
          $utf16: [...prefix, ...Array(slash).fill(92), surrogate, ...suffix],
        },
      });
  }
  const values = [
    null,
    undef,
    true,
    false,
    0,
    special("-0"),
    1,
    special("NaN"),
    special("Infinity"),
    "",
    "x",
    [],
    {},
    [1],
    { a: 1 },
  ];
  for (let i = 0; i < values.length; i++)
    for (let j = 0; j < values.length; j++)
      add(`compare.grid-${i}-${j}`, {
        op: "compare",
        expected: values[i],
        actual: values[j],
      });
  for (const [name, expected, actual] of [
    ["order", object(["z", 1], ["a", 2]), object(["a", 2], ["z", 1])],
    [
      "preorder",
      { z: 0, items: [{ done: true }, { done: true }] },
      { items: [{ done: true }, { done: false }], z: 1 },
    ],
    ["array-length", { a: [1, 2] }, { a: [1] }],
    ["undefined-missing", { a: undef }, {}],
    ["dotted-key", { "a.b[0]": 1 }, {}],
    ["utf16-order", object([utf16(0xe000), 1], [utf16(0xd800, 0xdc00), 2]), {}],
    ["lone-key", object([utf16(0xd800), 1]), {}],
    ["proto-empty", {}, object(["__proto__", {}])],
    ["proto-null", {}, object(["__proto__", null])],
    ["proto-own-nested", {}, object(["__proto__", { toString: undef }])],
  ])
    add(`compare.${name}`, { op: "compare", expected, actual });
  for (const key of [
    "toString",
    "toLocaleString",
    "valueOf",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "ordinary",
  ])
    for (const reverse of [false, true]) {
      const own = object([key, undef]);
      add(`compare.inherited-${key}-${reverse}`, {
        op: "compare",
        expected: reverse ? own : {},
        actual: reverse ? {} : own,
      });
    }
  const trace = {
    loaded: { count: 0 },
    msgs: [msg(1), msg(2), msg(3)],
    finalState: { count: 6 },
  };
  for (const [name, steps] of [
    ["absent", undefined],
    ["empty", []],
    ["short", [{ msg: msg(9), state: { count: 99 } }]],
    [
      "full",
      [1, 3, 6].map((count, i) => ({ msg: msg(i + 1), state: { count } })),
    ],
  ])
    for (const [label, limit] of [
      ["default", undefined],
      ["zero", 0],
      ["negative", -1],
      ["fraction", 1.9],
      ["nan", special("NaN")],
      ["infinity", special("Infinity")],
    ])
      add(`attachment.${name}.${label}`, {
        op: "attachment",
        trace: { ...trace, ...(steps === undefined ? {} : { steps }) },
        ...(limit === undefined ? {} : { limit }),
      });
  const seed = { type: "counter", count: 10 },
    additions = [1, 2, 3].map((by) => ({ type: "add", by }));
  for (const [name, loaded, msgs, finalState] of [
    ["match", seed, additions, { type: "counter", count: 16 }],
    ["mismatch", seed, additions, { type: "counter", count: 99 }],
    ["empty", seed, [], seed],
    ["missing", null, additions, seed],
    ["undefined-anchor", undef, [], undef],
    ["unknown-cell", seed, [{ type: "unknown" }], seed],
    ["replace-null", seed, [{ type: "replace", state: null }], null],
    ["replace-undefined", seed, [{ type: "replace", state: undef }], undef],
    [
      "nonfinite",
      seed,
      [{ type: "add", by: special("NaN") }],
      { type: "counter", count: special("NaN") },
    ],
  ])
    add(`replay.${name}`, {
      op: "replay",
      trace: { loaded, msgs, finalState },
    });
  const indices = [
    0,
    special("-0"),
    1.5,
    -2,
    1e21,
    1e-7,
    special("NaN"),
    special("Infinity"),
    special("-Infinity"),
  ];
  for (let i = 0; i < values.length; i++)
    add(`walk.${i}`, {
      op: "walk",
      value: values[i],
      path: i % 2 ? "state.a" : utf16(0xd800),
      key: i % 3 ? "a.b[0]" : utf16(0xdc00),
      index: indices[i % indices.length],
      left: object(["z", 0], [utf16(0xe000), 0], ["2", 0]),
      right: object([utf16(0xd800, 0xdc00), 0], ["a", 0], ["2", 1]),
    });
  return cases;
}

export function recorderLiteralChecks(assert, rows) {
  const get = (suffix) =>
    rows.find((row) => row.id === `recorder.${suffix}`).result;
  assert.deepEqual(get("compare.grid-4-5"), {
    equal: false,
    divergence: { path: "state", expected: 0, actual: { $number: "-0" } },
  });
  assert.deepEqual(get("compare.grid-7-7"), { equal: true, divergence: null });
  assert.equal(get("compare.preorder").divergence.path, "state.items[1].done");
  assert.equal(get("compare.array-length").divergence.path, "state.a");
  assert.equal(get("compare.undefined-missing").equal, true);
  assert.deepEqual(get("compare.inherited-toString-false").divergence, {
    path: "state.toString",
    expected: { $builtin: "toString" },
    actual: { $undefined: true },
  });
  assert.equal(get("parse.boot-missing").trace.finalState.$undefined, true);
  assert.equal(get("parse.null-state-tail").trace.finalState, 2);
  assert.equal(
    get("parse.missing-state-tail").trace.finalState.$undefined,
    true,
  );
  assert.equal(
    get("parse.sparse").rewrite,
    '{"kind":"boot","state":0}\n{"kind":"step","msg":{"type":"a"},"state":2}\n{"kind":"step","msg":{"type":"b"}}\n{"kind":"step","msg":{"type":"c"}}',
  );
  assert.equal(get("record.half.true").rows[3].trace.finalState.count, 20);
  assert.equal(get("record.half.true").rows[3].trace.msgs.length, 2);
  assert.deepEqual(
    get("record.reentrant.true").rows[0].trace.msgs.map((msg) => msg.payload),
    [2, 1],
  );
  assert.equal(get("record.reentrant.true").rows[0].trace.finalState, 2);
  assert.equal(get("record.all-dropped.true").rows[0].trace.finalState, 2);
  assert.equal(get("record.default.false").randomCalls, 0);
  assert.deepEqual(get("attachment.empty.zero").breadcrumbs, []);
  assert.equal(get("replay.match").actual.count, 16);
  assert.equal(get("replay.match").updates, 3);
  assert.equal(
    get("replay.missing").error.message,
    "tea replayTrace: trace has no captured initial State; record boot before replaying.",
  );
}
