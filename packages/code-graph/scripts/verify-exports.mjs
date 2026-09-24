const expected = {
  "@demlik/code-graph/project": ["loadEdgeProject", "loadCheapProject", "listSourceFiles"],
  "@demlik/code-graph/resolve": [],
};

const failures = [];
for (const [specifier, names] of Object.entries(expected)) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (error) {
    failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  for (const name of names) {
    if (typeof mod[name] !== "function") failures.push(`${specifier}: no function export ${name}`);
  }
}

if (failures.length > 0) {
  console.error(`verify-exports: ${failures.length} export check(s) failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`verify-exports: ${Object.keys(expected).length} subpaths import from dist`);
