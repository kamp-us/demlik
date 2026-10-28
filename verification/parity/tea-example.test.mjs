import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const aliases = [
  "CARGO_TARGET_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
];

// A deterministic Cargo protocol replay, not an actual compiler or parity case.
function fixture() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "demlik-cargo-selection-contract-"),
  );
  const target = path.join(root, "target", path.basename(dir));
  fs.mkdirSync(target, { recursive: true });
  const executable = path.join(target, "runtime_driver-hashed-selection"),
    library = path.join(target, "libdemlik_tea-selected.rlib"),
    invoked = path.join(dir, "invoked.json");
  fs.writeFileSync(executable, "selected executable bytes");
  fs.writeFileSync(library, "selected library bytes");
  const source = path.join(root, "crates/tea/examples/runtime_driver.rs");
  const manifest = path.join(root, "crates/tea/Cargo.toml");
  const packageId = `path+file://${path.join(root, "crates/tea")}#demlik-tea@0.1.0`;
  const events = [
    {
      reason: "compiler-artifact",
      package_id: packageId,
      manifest_path: manifest,
      target: {
        name: "demlik_tea",
        kind: ["lib"],
        src_path: path.join(root, "crates/tea/src/lib.rs"),
      },
      filenames: [library],
      executable: null,
      features: ["default"],
      fresh: false,
    },
    {
      reason: "compiler-artifact",
      package_id: packageId,
      manifest_path: manifest,
      target: { name: "runtime_driver", kind: ["example"], src_path: source },
      filenames: [executable],
      executable,
      features: ["default"],
      fresh: false,
    },
  ];
  const cargo = path.join(dir, "cargo-replay");
  const writeCargo = (rows) =>
    fs.writeFileSync(
      cargo,
      `#!${process.execPath}\nimport fs from "node:fs";fs.writeFileSync(${JSON.stringify(invoked)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(rows.map((x) => JSON.stringify(x)).join("\n") + "\n")});\n`,
      { mode: 0o755 },
    );
  writeCargo(events);
  return {
    dir,
    target,
    executable,
    library,
    invoked,
    cargo,
    events,
    writeCargo,
    report: path.join(dir, "report.json"),
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    },
  };
}

for (const key of aliases)
  test(`${key} is refused before Cargo`, () => {
    const f = fixture();
    const saved = process.env[key];
    process.env[key] = "/not-an-owned-default-target";
    try {
      assert.throws(
        () => buildTeaExample(f.cargo, "runtime_driver", f.report),
        new RegExp(`${key} must be unset`),
      );
      assert.equal(fs.existsSync(f.invoked), false);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
      f.remove();
    }
  });

test("retains actual selected executable and library before later replacement", () => {
  const f = fixture();
  try {
    const p = buildTeaExample(f.cargo, "runtime_driver", f.report);
    assert.equal(p.actualArtifact, f.executable);
    assert.equal(p.binarySha256, hash("selected executable bytes"));
    assert.equal(p.libraries.demlik_tea.path, f.library);
    assert.equal(
      typeof p.libraries.demlik_tea.retainedPath,
      "string",
      "selected library bytes must be retained",
    );
    assert.equal(p.libraries.demlik_tea.artifact.fresh, false);
    assert.equal(p.driver.target.name, "runtime_driver");
    assert.deepEqual(JSON.parse(fs.readFileSync(f.invoked, "utf8")), [
      "build",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      "--example",
      "runtime_driver",
      "--message-format=json",
    ]);
    fs.writeFileSync(f.executable, "later executable");
    fs.writeFileSync(f.library, "later library");
    assert.equal(
      fs.readFileSync(p.binary, "utf8"),
      "selected executable bytes",
    );
    assert.equal(
      gunzipSync(
        fs.readFileSync(p.libraries.demlik_tea.retainedPath),
      ).toString(),
      "selected library bytes",
    );
    assert.equal(p.cargoJsonSha256, hash(fs.readFileSync(p.cargoJson)));
  } finally {
    f.remove();
  }
});

test("rejects a matching target from the wrong package manifest", () => {
  const f = fixture();
  f.events[1].manifest_path = path.join(root, "crates/code-graph/Cargo.toml");
  f.writeCargo(f.events);
  try {
    assert.throws(
      () => buildTeaExample(f.cargo, "runtime_driver", f.report),
      /manifest|Cargo.toml/,
    );
  } finally {
    f.remove();
  }
});

test("does not guess an executable when Cargo emits none", () => {
  const f = fixture();
  f.writeCargo(f.events.slice(0, 1));
  try {
    assert.throws(
      () => buildTeaExample(f.cargo, "runtime_driver", f.report),
      /one actual Cargo-selected/,
    );
  } finally {
    f.remove();
  }
});

test("rejects missing requested features and a foreign library selection", () => {
  const f = fixture();
  try {
    assert.throws(
      () => buildTeaExample(f.cargo, "runtime_driver", f.report, ["pbt"]),
      /selected target requires pbt/,
    );
    f.events[0].manifest_path = path.join(root, "crates/code-graph/Cargo.toml");
    f.writeCargo(f.events);
    assert.throws(
      () => buildTeaExample(f.cargo, "runtime_driver", f.report),
      /Cargo.toml/,
    );
  } finally {
    f.remove();
  }
});
