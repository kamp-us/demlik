export function changesetTextCases() {
  const cases = [],
    add = (id, text) =>
      cases.push({
        id: `api-base.parse.${id}`,
        operation: "parse",
        input: { text },
      });
  add(
    "ordered",
    "---\n\"@demo/pkg\": minor\n'__proto__': patch\n@demo/pkg: major\n---\n\nBody\n---\nmore\n",
  );
  add("empty", "---\n---\n");
  add("body-cr", "---\n---\nlast\r");
  add("bare-cr", "---\ra: patch\r---");
  add("bom", "\ufeff---\r\na: major\r\n---\r\nBody\r\n");
  add("two-boms", "\ufeff\ufeff---\n---\n");
  for (const name of [
    "a",
    "@demo/pkg",
    "__proto__",
    "constructor",
    "toString",
    "1",
    "01",
    "a:b",
    "a b",
    "a#b",
    "a\\nb",
    "\ud800",
    "\udfff",
    "😀",
    " ",
  ])
    for (const quote of ["", '"', "'"])
      for (const bump of ["none", "patch", "minor", "major", "PATCH", "huge"])
        add(
          `names-${cases.length}`,
          `---\n${quote}${name}${quote}: ${bump}\n---\nbody\udfff\r`,
        );
  for (const unit of [
    9, 11, 12, 13, 32, 160, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
    0x205f, 0x3000, 0xfeff, 0x85, 0x180e, 0x200b,
  ]) {
    const w = String.fromCharCode(unit);
    add(
      `whitespace-${unit}`,
      `---${w}\n${w}\n${w}"a"${w}:${w}minor${w}\n---${w}\nBody`,
    );
    add(`leading-${unit}`, `${w}---\na: patch\n---\n`);
  }
  for (const text of [
    "",
    "---",
    "---\n",
    "---\na: patch\n",
    '---\n"": minor\n---\n',
    '---\n"a\\"b": patch\n---\n',
    '---\n"\\ud800": none\n---\n',
    "---\na: patch # comment\n---\n",
    "---\nnot a bump\n---\n",
    "---\na: patch\n ---\n",
    "---\n# comment\n---\n",
    "---\n2: patch\n1: minor\n2: major\n---\n",
    "---\na: patch\na: none\n---\n",
  ])
    add(`refusal-${cases.length}`, text);
  return cases;
}
