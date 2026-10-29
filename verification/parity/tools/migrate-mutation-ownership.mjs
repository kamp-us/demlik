import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const directory = path.resolve(import.meta.dirname, "..");
const write = process.argv.includes("--write");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const aliases = new Set([
  "CARGO_TARGET_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
]);
const report = [];
const packageFile = path.join(directory, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageFile));
const entries = [
  ...pkg.scripts["verify:mutations"].matchAll(
    /node (?:check-worktree\.mjs entry )?(?:--import \S+ )?([a-z0-9-]+\.mjs)/g,
  ),
].map((m) => m[1]);
const reachable = new Set();
function follow(file) {
  if (reachable.has(file) || !fs.existsSync(path.join(directory, file))) return;
  reachable.add(file);
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(path.join(directory, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const n of nodes(ast, ts.isStringLiteralLike))
    if (/\.(mjs|mts)$/.test(n.text)) follow(path.basename(n.text));
}
entries.forEach(follow);

function nodes(node, predicate) {
  const found = [];
  function visit(n) {
    if (predicate(n)) found.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}
function name(n) {
  return ts.isIdentifier(n)
    ? n.text
    : ts.isPropertyAccessExpression(n)
      ? n.name.text
      : "";
}
function semantic(n) {
  if (
    ts.isStringLiteralLike(n) ||
    ts.isNumericLiteral(n) ||
    ts.isIdentifier(n) ||
    n.kind === ts.SyntaxKind.RegularExpressionLiteral
  )
    return [n.kind, n.text];
  const children = [];
  ts.forEachChild(n, (child) => {
    children.push(semantic(child));
  });
  return [n.kind, ...children];
}

function faultDigest(source) {
  const tables = nodes(
    source,
    (n) =>
      ts.isVariableDeclaration(n) &&
      /^(controls|mutations|faults|edits)$/.test(n.name.getText(source)) &&
      n.initializer &&
      ts.isArrayLiteralExpression(n.initializer) &&
      n.initializer.elements.length,
  ).map((n) => semantic(n.initializer));
  // Also retain imperative table construction and literal witness/needle/before/after payloads.
  const fields = nodes(
    source,
    (n) =>
      ts.isPropertyAssignment(n) &&
      /^(witness|needle|fault|before|after|replacement|edits|ids|id|name)$/.test(
        n.name.getText(source),
      ),
  ).map(semantic);
  const markers = nodes(
    source,
    (n) =>
      ts.isVariableDeclaration(n) &&
      /^(before|needle|replacement|fault)$/.test(n.name.getText(source)) &&
      n.initializer,
  ).map((n) => semantic(n.initializer));
  return sha(JSON.stringify([tables, fields, markers]));
}
for (const file of fs
  .readdirSync(directory)
  .filter(
    (f) =>
      /\.(mjs|mts)$/.test(f) &&
      !["run.mjs", "check-worktree.mjs", "check-worktree.test.mjs"].includes(f),
  )) {
  const absolute = path.join(directory, file),
    text = fs.readFileSync(absolute, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const edits = [],
    imports = new Set();
  const add = (node, replacement) =>
    edits.push({ start: node.getStart(source), end: node.end, replacement });
  const calls = nodes(source, ts.isCallExpression);
  const declarations = nodes(source, ts.isVariableDeclaration);
  const legacyCopies = calls.filter(
    (n) =>
      ["cp", "cpSync"].includes(name(n.expression)) &&
      n.arguments.length >= 2 &&
      /(?:Cargo\.toml|crates|root\s*,)/.test(n.arguments[0].getText(source)) &&
      /(?:join|resolve)\(/.test(n.arguments[1].getText(source)) &&
      !/control-binaries|artifact|saved|evidence/.test(
        n.arguments[1].getText(source),
      ),
  );
  const owners = new Set();
  for (const call of legacyCopies) {
    const destination = call.arguments[1];
    if (
      ts.isCallExpression(destination) &&
      ts.isIdentifier(destination.arguments[0])
    )
      owners.add(destination.arguments[0].text);
  }
  // Only copied source workspaces with a temporary allocation are migrated.
  const groups = new Map();
  for (const owner of owners) {
    const ownerDecl = declarations.find(
      (n) => n.name.getText(source) === owner,
    );
    if (!ownerDecl?.initializer) continue;
    let allocation = ownerDecl;
    if (
      !nodes(
        allocation.initializer,
        (n) => ts.isCallExpression(n) && /mkdtemp/.test(name(n.expression)),
      ).length
    ) {
      const inputs = nodes(allocation.initializer, ts.isIdentifier).map(
        (n) => n.text,
      );
      allocation = declarations.find(
        (n) =>
          inputs.includes(n.name.getText(source)) &&
          n.initializer &&
          nodes(
            n.initializer,
            (c) => ts.isCallExpression(c) && /mkdtemp/.test(name(c.expression)),
          ).length,
      );
    }
    if (
      !allocation ||
      (!nodes(
        source,
        (n) =>
          ts.isPropertyAssignment(n) &&
          aliases.has(n.name.getText(source)) &&
          n.initializer.kind !== ts.SyntaxKind.NullKeyword,
      ).length &&
        !legacyCopies.some((c) =>
          /crates|Cargo\.toml/.test(c.arguments[0].getText(source)),
        ))
    )
      continue;
    let scope = allocation.parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope))
      scope = scope.parent;
    if (!groups.has(scope))
      groups.set(scope, { allocation, roots: new Set(), targets: new Set() });
    const group = groups.get(scope);
    group.roots.add(owner);
    group.roots.add(allocation.name.getText(source));
  }
  for (const [scope, group] of groups) {
    imports.add("createCheckWorktree");
    const label = file.replace(/\.[^.]+$/, "");
    const ref = "mutationCheck";
    for (const prop of nodes(
      scope,
      (n) => ts.isPropertyAssignment(n) && aliases.has(n.name.getText(source)),
    )) {
      if (
        ts.isIdentifier(prop.initializer) &&
        !/baseline/i.test(prop.initializer.text)
      )
        group.targets.add(prop.initializer.text);
    }
    for (const decl of nodes(scope, ts.isVariableDeclaration))
      if (
        /^(target|targetDirectory|mutationTarget)$/.test(
          decl.name.getText(source),
        ) &&
        decl.initializer &&
        /control|mutat|fault/.test(decl.initializer.getText(source))
      )
        group.targets.add(decl.name.getText(source));
    // Existing target aliases can precede source allocation in the same scope.
    for (const decl of declarations.filter(
      (n) =>
        group.roots.has(n.name.getText(source)) ||
        group.targets.has(n.name.getText(source)),
    )) {
      if (!decl.initializer) continue;
      add(
        decl.initializer,
        `${ref}.${group.roots.has(decl.name.getText(source)) ? "root" : "target"}`,
      );
    }
    for (const call of calls.filter(
      (n) =>
        ["cp", "cpSync"].includes(name(n.expression)) &&
        n.arguments.length >= 2,
    )) {
      const destination = call.arguments[1];
      if (
        !ts.isCallExpression(destination) ||
        !group.roots.has(destination.arguments[0]?.getText(source))
      )
        continue;
      let statement = call;
      while (statement.parent && !ts.isExpressionStatement(statement))
        statement = statement.parent;
      // Copy-only loops and optional .cargo copies have no other side effects.
      while (
        ts.isForOfStatement(statement.parent) ||
        ts.isIfStatement(statement.parent) ||
        (ts.isBlock(statement.parent) &&
          statement.parent.statements.length === 1 &&
          (ts.isForOfStatement(statement.parent.parent) ||
            ts.isIfStatement(statement.parent.parent)))
      )
        statement = statement.parent;
      add(statement, "");
    }
    for (const call of calls) {
      const fn = name(call.expression),
        arg = call.arguments[0]?.getText(source);
      if (!group.roots.has(arg) && !group.targets.has(arg)) continue;
      if (["rm", "rmSync", "rmdirSync", "mkdir", "mkdirSync"].includes(fn)) {
        let statement = call;
        while (statement.parent && !ts.isExpressionStatement(statement))
          statement = statement.parent;
        add(statement, "");
      }
    }
    const affected = declarations.filter(
      (n) =>
        group.roots.has(n.name.getText(source)) ||
        group.targets.has(n.name.getText(source)),
    );
    let first = affected.reduce((a, b) =>
      a.getStart(source) < b.getStart(source) ? a : b,
    );
    while (first.parent !== scope) first = first.parent;
    const start = first.getStart(source),
      end = ts.isSourceFile(scope) ? scope.end : scope.end - 1;
    const tail = scope.statements.filter((n) => n.getStart(source) >= start);
    assert(
      !tail.some((n) =>
        n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      ),
      `${file}: cannot wrap exports`,
    );
    edits.push({
      start,
      end: start,
      replacement: `const ${ref} = createCheckWorktree(process.cwd(), ${JSON.stringify(label)});\nlet mutationFailure${file.endsWith(".mts") ? ": unknown" : ""};\ntry {\n`,
    });
    edits.push({
      start: end,
      end,
      replacement: `\n} catch (error) { mutationFailure = error; throw error; } finally { ${ref}.remove(mutationFailure); }\n`,
    });
  }
  // Remove target overrides as assignments, retaining null metadata and guards.
  for (const object of nodes(source, ts.isObjectLiteralExpression)) {
    const unsafe = object.properties.filter(
      (n) =>
        ts.isPropertyAssignment(n) &&
        aliases.has(n.name.getText(source)) &&
        n.initializer.kind !== ts.SyntaxKind.NullKeyword,
    );
    if (!unsafe.length) continue;
    for (const prop of unsafe) {
      const index = object.properties.indexOf(prop),
        next = object.properties[index + 1];
      edits.push({
        start: prop.getStart(source),
        end: next ? next.getStart(source) : object.end - 1,
        replacement: "",
      });
      // Last property's preceding comma can remain as a legal trailing comma.
    }
  }
  // Intercept Cargo only; subprocess/source execution arguments stay untouched.
  for (const imp of source.statements.filter(ts.isImportDeclaration)) {
    if (!reachable.has(file) || !/CARGO|cargo/.test(text)) continue;
    if (
      imp.moduleSpecifier.text !== "node:child_process" ||
      !imp.importClause?.namedBindings ||
      !ts.isNamedImports(imp.importClause.namedBindings)
    )
      continue;
    const elements = imp.importClause.namedBindings.elements;
    const wrapped = elements.filter((n) =>
      ["spawnSync", "execFileSync"].includes(
        n.propertyName?.text ?? n.name.text,
      ),
    );
    if (!wrapped.length) continue;
    const remaining = elements.filter((n) => !wrapped.includes(n));
    add(
      imp,
      remaining.length
        ? `import { ${remaining.map((n) => n.getText(source)).join(", ")} } from 'node:child_process';`
        : "",
    );
    for (const entry of wrapped)
      imports.add(
        `checked${(entry.propertyName?.text ?? entry.name.text)[0].toUpperCase()}${(entry.propertyName?.text ?? entry.name.text).slice(1)} as ${entry.name.text}`,
      );
  }
  if (!edits.length) continue;
  // Discard edits nested inside a removed copy statement, and reject ambiguous overlaps.
  const nonzero = edits.filter((e) => e.end > e.start);
  const filtered = edits.filter(
    (e) =>
      !nonzero.some(
        (other) =>
          other !== e &&
          other.start <= e.start &&
          other.end >= e.end &&
          (other.start < e.start || other.end > e.end),
      ),
  );
  filtered.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  for (let i = 0; i < filtered.length; i++) {
    if (i && filtered[i].end > filtered[i - 1].start)
      throw new Error(`${file}: overlapping AST edits`);
    const e = filtered[i];
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  if (imports.size)
    result =
      `import { ${[...imports].sort().join(", ")} } from './check-worktree.mjs';\n` +
      result;
  const updated = ts.createSourceFile(
    file,
    result,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  assert.equal(
    updated.parseDiagnostics.length,
    0,
    `${file}: parse after migration`,
  );
  assert.equal(
    faultDigest(updated),
    faultDigest(source),
    `${file}: fault/witness definitions must be preserved`,
  );
  if (result !== text) {
    report.push({
      file,
      owners: groups.size,
      faultDigest: faultDigest(source),
      before: sha(text),
      after: sha(result),
    });
    if (write) fs.writeFileSync(absolute, result);
  }
}
for (const file of fs
  .readdirSync(directory)
  .filter((f) => /(?:types|probes)\.mjs$/.test(f) && reachable.has(f))) {
  const absolute = path.join(directory, file),
    text = fs.readFileSync(absolute, "utf8");
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const edits = nodes(
    ast,
    (n) =>
      ts.isCallExpression(n) &&
      /mkdtemp/.test(name(n.expression)) &&
      /tmpdir/.test(n.getText(ast)),
  ).map((n) => ({
    start: n.getStart(ast),
    end: n.end,
    replacement: `checkScratchDirectory(${JSON.stringify(`${file.replace(/\.mjs$/, "")}-`)})`,
  }));
  if (!edits.length) continue;
  let updated = text;
  for (const e of edits.reverse())
    updated = updated.slice(0, e.start) + e.replacement + updated.slice(e.end);
  updated =
    `import { checkScratchDirectory } from './check-worktree.mjs';\n` + updated;
  report.push({
    file,
    scratchDirectories: edits.length,
    before: sha(text),
    after: sha(updated),
  });
  if (write) fs.writeFileSync(absolute, updated);
}
let packageChanged = false;
for (const [key, value] of Object.entries(pkg.scripts)) {
  const next = value
    .split(" && ")
    .map((command) => {
      if (
        command.startsWith("node check-worktree.mjs entry ") ||
        !command.startsWith("node ") ||
        command.startsWith("node --test ")
      )
        return command;
      const entry = command.match(
        /^node (?:--import \S+ )?([a-z0-9-]+\.mjs)(?: |$)/,
      )?.[1];
      return entry && reachable.has(entry)
        ? command.replace(/^node /, "node check-worktree.mjs entry ")
        : command;
    })
    .join(" && ");
  if (next !== value) {
    pkg.scripts[key] = next;
    packageChanged = true;
  }
}
if (packageChanged) {
  report.push({
    file: "package.json",
    structuredEntryArgumentsPreserved: true,
  });
  if (write) fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + "\n");
}
if (!process.argv.includes("--audit-base"))
  console.log(
    JSON.stringify(
      {
        mode: write ? "write" : "check",
        files: report.length,
        changes: report,
      },
      null,
      2,
    ),
  );

const auditBase = process.argv[process.argv.indexOf("--audit-base") + 1];
if (process.argv.includes("--audit-base")) {
  assert.match(auditBase, /^[a-f0-9]{40}$/);
  const checked = [];
  for (const file of [...reachable].sort()) {
    if (!/\.(mjs|mts)$/.test(file) || file === "run.mjs") continue;
    const current = fs.readFileSync(path.join(directory, file), "utf8");
    const before = execFileSync(
      "git",
      ["show", `${auditBase}:verification/parity/${file}`],
      { cwd: directory, encoding: "utf8", maxBuffer: 32 << 20 },
    );
    const ast = ts.createSourceFile(
      file,
      current,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(ast.parseDiagnostics.length, 0, `${file}: parses`);
    const frozen = ts.createSourceFile(
      file,
      before,
      ts.ScriptTarget.Latest,
      true,
    );
    assert.equal(
      faultDigest(ast),
      faultDigest(frozen),
      `${file}: original fault and witness literals`,
    );
    const overrides = nodes(
      ast,
      (n) =>
        ts.isPropertyAssignment(n) &&
        aliases.has(n.name.getText(ast)) &&
        n.initializer.kind !== ts.SyntaxKind.NullKeyword,
    );
    assert.equal(overrides.length, 0, `${file}: no target alias assignment`);
    const copiedCrates = nodes(
      ast,
      (n) =>
        ts.isCallExpression(n) &&
        ["cp", "cpSync"].includes(name(n.expression)) &&
        n.arguments[0] &&
        /(?:^["']crates["']$|["']Cargo\.toml["'])/.test(
          n.arguments[0].getText(ast),
        ),
    );
    assert.equal(copiedCrates.length, 0, `${file}: no copied crate workspace`);
    checked.push({
      file,
      beforeSha256: sha(before),
      afterSha256: sha(current),
      faultDigest: faultDigest(ast),
    });
  }
  const originalPackage = JSON.parse(
    execFileSync(
      "git",
      ["show", `${auditBase}:verification/parity/package.json`],
      { cwd: directory, encoding: "utf8" },
    ),
  );
  for (const [key, value] of Object.entries(originalPackage.scripts))
    assert.equal(
      pkg.scripts[key].replaceAll("node check-worktree.mjs entry ", "node "),
      value,
      `${key}: original Node imports and suite argv preserved`,
    );
  console.log(
    JSON.stringify(
      {
        mode: write ? "write" : "check",
        files: report.length,
        changes: report,
        auditBase,
        staticOverapproximation: true,
        aggregateExecuted: false,
        reachableFiles: checked.length,
        checked,
      },
      null,
      2,
    ),
  );
}
