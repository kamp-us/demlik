import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subscriptionRegressions } from "./subscription-conformance-regressions.mjs";
import { subscriptionConformance } from "./subscription-conformance-run.mjs";
import { subscriptionTypes } from "./subscription-conformance-types.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function subscriptionGates(options = {}) {
  for (const key of [
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined);
  const directory =
    options.directory ??
    path.join(root, "target/parity/subscription-conformance/gates");
  await mkdir(directory, { recursive: true });
  const commands = [],
    artifacts = { examples: {}, tests: {}, libraries: {}, executed: [] };
  async function command(label, program, args) {
    const result = spawnSync(program, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    await writeFile(
      path.join(directory, `${label}.stdout`),
      result.stdout ?? "",
    );
    await writeFile(
      path.join(directory, `${label}.stderr`),
      result.stderr ?? "",
    );
    const row = {
      label,
      command: [program, ...args],
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    };
    commands.push(row);
    await writeFile(
      path.join(directory, "commands.json"),
      `${JSON.stringify(commands, null, 2)}\n`,
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    return result;
  }
  const cargo = process.env.CARGO ?? "cargo";
  for (const [configuration, features] of [
    ["default", []],
    ["pbt", ["--features", "pbt"]],
  ]) {
    const result = await command(`test-${configuration}`, cargo, [
      "test",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      ...features,
      "--message-format=json",
    ]);
    const rows = result.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map(JSON.parse);
    const lib = rows.filter(
      (r) =>
        r.reason === "compiler-artifact" &&
        r.target.name === "demlik_tea" &&
        r.target.kind.includes("lib") &&
        !r.profile.test &&
        r.filenames.some((f) => f.endsWith(".rlib")),
    );
    assert.equal(lib.length, 1);
    const library = lib[0].filenames.find((f) => f.endsWith(".rlib"));
    artifacts.libraries[configuration] = {
      path: library,
      sha256: hash(await readFile(library)),
      selected: lib[0],
    };
    for (const row of rows.filter(
      (r) => r.reason === "compiler-artifact" && r.executable && r.profile.test,
    )) {
      assert.ok(row.executable.startsWith(path.join(root, "target/")));
      const retained = path.join(
        directory,
        `${configuration}-${row.target.name}-${hash(await readFile(row.executable))}.bin`,
      );
      await copyFile(row.executable, retained);
      artifacts.executed.push({
        configuration,
        path: retained,
        sha256: hash(await readFile(retained)),
        selected: row,
      });
      if (configuration === "default")
        artifacts.tests[row.target.name] = retained;
    }
    const counts = [
      ...result.stdout.matchAll(
        /test result: ok\. (\d+) passed; (\d+) failed/g,
      ),
    ];
    commands.at(-1).passed = counts.reduce((n, m) => n + Number(m[1]), 0);
    commands.at(-1).failed = counts.reduce((n, m) => n + Number(m[2]), 0);
    const types = subscriptionTypes(
      artifacts.libraries[configuration],
      path.join(directory, `types-${configuration}`),
    );
    assert.equal(types.checks.length, 3);
    await command(`clippy-${configuration}`, cargo, [
      "clippy",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      ...features,
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
  }
  await command("fmt", cargo, ["fmt", "--all", "--check"]);
  await command("typescript", "pnpm", [
    "--filter",
    "@demlik/parity",
    "exec",
    "tsc",
    "--noEmit",
    "-p",
    "tsconfig.json",
  ]);
  await command("biome", "pnpm", [
    "exec",
    "biome",
    "check",
    ...[
      "verification/parity/subscription-conformance-cases.mjs",
      "verification/parity/subscription-conformance-cases.d.mts",
      "verification/parity/subscription-conformance-reference.mts",
      "verification/parity/subscription-conformance-run.mjs",
      "verification/parity/subscription-conformance-controls.mjs",
      "verification/parity/subscription-conformance-checks.mjs",
      "verification/parity/subscription-conformance-types.mjs",
      "verification/parity/subscription-conformance-regressions.mjs",
      "verification/parity/subscription-conformance-gates.mjs",
    ],
  ]);
  await command("effect-cleanup-source-only", "pnpm", [
    "exec",
    "node",
    "--import",
    require.resolve("tsx"),
    "verification/parity/subscription-effect-cleanup-probe.mts",
    path.join(directory, "effect-source-only.json"),
  ]);
  const examples = [
    "subscription_conformance_driver",
    "typed_reducer_driver",
    "runtime_driver",
    "runtime_contract_driver",
    "runtime_hooks_driver",
    "runtime_deadline_driver",
  ];
  const build = await command("examples", cargo, [
    "build",
    "--locked",
    "--offline",
    "-p",
    "demlik-tea",
    ...examples.flatMap((x) => ["--example", x]),
    "--message-format=json",
  ]);
  const rows = build.stdout.split("\n").filter(Boolean).map(JSON.parse);
  for (const name of examples) {
    const selected = rows.filter(
      (r) =>
        r.reason === "compiler-artifact" &&
        r.target.name === name &&
        r.executable,
    );
    assert.equal(selected.length, 1);
    const file = selected[0].executable;
    const retained = path.join(
      directory,
      `${name}-${hash(await readFile(file))}.bin`,
    );
    await copyFile(file, retained);
    artifacts.examples[name] = retained;
  }
  await writeFile(
    path.join(directory, "selected-artifacts.json"),
    `${JSON.stringify(artifacts, null, 2)}\n`,
  );
  const pairs = await subscriptionConformance({
    binary: artifacts.examples.subscription_conformance_driver,
    reportFile: path.join(directory, "pairs.json"),
    quiet: true,
  });
  assert.equal(pairs.passed, 65);
  assert.equal(pairs.qualifiedPassed, 3);
  assert.deepEqual(pairs.failures, []);
  const regressions = await subscriptionRegressions(
    artifacts,
    path.join(directory, "regressions"),
  );
  await writeFile(
    path.join(directory, "commands.json"),
    `${JSON.stringify(commands, null, 2)}\n`,
  );
  const report = {
    commands,
    artifacts,
    pairs: {
      cases: pairs.cases,
      passed: pairs.passed,
      qualifiedCases: pairs.qualifiedCases,
      qualifiedPassed: pairs.qualifiedPassed,
      reportFile: path.join(directory, "pairs.json"),
    },
    regressions: Object.fromEntries(
      Object.entries(regressions).map(([k, r]) => [
        k,
        {
          cases: r.cases,
          passed: r.passed,
          failures: r.failures ?? [],
          reportFile: r.reportFile,
        },
      ]),
    ),
  };
  await writeFile(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await subscriptionGates();
  console.log(
    JSON.stringify({
      tests: report.commands
        .filter((c) => c.passed !== undefined)
        .map((c) => ({ configuration: c.label, passed: c.passed })),
      pairs: report.pairs,
      regressions: report.regressions,
    }),
  );
}
