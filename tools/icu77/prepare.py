#!/usr/bin/env python3
"""Prepare or verify the private ICU77 static input for this workspace only."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import sys
import tarfile
import time

if sys.version_info < (3, 12):
    raise SystemExit("ICU77 preparation requires Python >=3.12 (stdlib tomllib and filtered tar extraction)")
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = ROOT / "target/icu77"
PIN_FILE = ROOT / "tools/icu77/inputs.json"
ALIASES = ("CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CARGO_BUILD_BUILD_DIR", "DEMLIK_MUTATION_TARGET_DIR")


def sha(file, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with pathlib.Path(file).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pins():
    return json.loads(PIN_FILE.read_text())


def host_check(host, target):
    require(not any(key in os.environ for key in ALIASES), "all four target overrides must be unset")
    require(platform.system() == "Darwin" and platform.machine() == "arm64", "only the verified aarch64 macOS native preparation is supported")
    require(host == target == "aarch64-apple-darwin", "cross-compilation and other targets are not verified")


def bindings(expected):
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
    for name, checksum in expected["bindings"].items():
        packages = [p for p in lock["package"] if p["name"] == name]
        require(len(packages) == 1 and packages[0]["version"] == "5.8.0" and packages[0]["checksum"] == checksum, f"locked ICU binding differs: {name}")
    deps = tomllib.loads((ROOT / "crates/code-graph/Cargo.toml").read_text())["dependencies"]
    config = {}
    for name in ("rust_icu_common", "rust_icu_sys", "rust_icu_ucol", "rust_icu_ustring"):
        spec = deps[name]
        wanted = {"renaming", "icu_version_in_env"} | ({"static"} if name == "rust_icu_sys" else set())
        require(spec["version"] == "=5.8.0" and spec["default-features"] is False and set(spec["features"]) == wanted, f"binding features differ: {name}")
        config[name] = {"version": spec["version"], "features": sorted(wanted), "default-features": False}
    return config


def native_env():
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC", "TMPDIR": str(ROOT / "target/tmp"), "CC": "/usr/bin/clang", "CXX": "/usr/bin/clang++", "CFLAGS": "-O2 -g0", "CXXFLAGS": "-O2 -g0 -std=c++17"}


def run(name, argv, cwd, env):
    logs = BASE / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with (logs / (name + ".stdout")).open("wb") as out, (logs / (name + ".stderr")).open("wb") as err:
        child = subprocess.run(argv, cwd=cwd, env=env, stdout=out, stderr=err)
    record = {"argv": [str(a) for a in argv], "cwd": str(cwd), "environment": env, "exit": child.returncode, "seconds": time.monotonic() - started, "stdoutSha256": sha(logs / (name + ".stdout")), "stderrSha256": sha(logs / (name + ".stderr"))}
    (logs / (name + ".json")).write_text(json.dumps(record, indent=2) + "\n")
    require(child.returncode == 0, f"native preparation {name} failed with exit {child.returncode}; see {logs}")
    return record


def verify(args):
    host_check(args.host, args.target)
    expected = pins()
    stamp_path = BASE / "prepared.json"
    require(os.environ.get("DEMLIK_ICU77_PREPARED") == str(stamp_path), "DEMLIK_ICU77_PREPARED must name this worktree's target/icu77/prepared.json")
    require(os.environ.get("RUST_ICU_LINK_SEARCH_DIR") == str(BASE / "install/lib"), "ICU link search must use this worktree's private static install")
    require(os.environ.get("RUST_ICU_MAJOR_VERSION_NUMBER") == "77", "ICU bindings must select version77")
    stamp = json.loads(stamp_path.read_text())
    require(stamp["root"] == str(ROOT) and stamp["host"] == args.host and stamp["target"] == args.target, "prepared owner/host differs")
    require(stamp["prepareSha256"] == sha(__file__) and stamp["pinsSha256"] == sha(PIN_FILE), "preparation implementation or pinned inputs changed")
    require(stamp["bindings"] == bindings(expected), "binding configuration changed")
    require(stamp["flags"] == expected["configureFlags"], "native preparation flags changed")
    for name, value in stamp["archives"].items():
        file = BASE / "install/lib" / name
        require(file.stat().st_size == value["bytes"] and sha(file) == value["sha256"], f"native archive changed: {name}")
    require(set(stamp["archives"]) == {"libicuuc.a", "libicui18n.a", "libicudata.a"}, "missing static linked archive")
    data = BASE / "source/icu/source/data/in/icudt77l.dat"
    require(sha(data) == expected["dataSha256"] and data.stat().st_size == expected["dataBytes"], "release data changed")
    require(stamp["dataSha256"] == expected["dataSha256"], "prepared data pin differs")
    for name, checksum in expected["licenses"].items():
        require(sha(ROOT / "crates/code-graph/licenses" / name) == checksum, f"distribution license changed: {name}")
    print("verified private static ICU77 source/data/binding/archive contract; no runtime-version getter claim")


def prepare(args):
    host_check(args.host, args.target)
    expected = pins()
    binding_config = bindings(expected)
    source_archive = pathlib.Path(args.source_archive).resolve()
    require(sha(source_archive, "sha512") == expected["sourceSha512"], "ICU77 source archive checksum mismatch")
    require(not (BASE / "attempt.json").exists(), "native preparation was already attempted in this owning tree; retain the failure instead of retrying silently")
    BASE.mkdir(parents=True, exist_ok=True)
    (ROOT / "target/tmp").mkdir(parents=True, exist_ok=True)
    (BASE / "attempt.json").write_text(json.dumps({"sourceArchive": str(source_archive), "sourceSha512": expected["sourceSha512"], "host": args.host, "target": args.target}, indent=2) + "\n")
    metadata = subprocess.run([args.cargo, "metadata", "--no-deps", "--offline", "--format-version=1"], cwd=ROOT, capture_output=True, text=True)
    (BASE / "metadata.stdout").write_text(metadata.stdout)
    (BASE / "metadata.stderr").write_text(metadata.stderr)
    require(metadata.returncode == 0, "cannot establish owning workspace default target")
    info = json.loads(metadata.stdout)
    require(pathlib.Path(info["workspace_root"]).resolve() == ROOT and pathlib.Path(info["target_directory"]).resolve() == ROOT / "target", "ICU preparation requires the root workspace default target directly")
    source = BASE / "source"
    source.mkdir()
    with tarfile.open(source_archive) as archive:
        archive.extractall(source, filter="data")
    data = source / "icu/source/data/in/icudt77l.dat"
    require(data.stat().st_size == expected["dataBytes"] and sha(data) == expected["dataSha256"], "bundled ICU77 data checksum mismatch")
    build = BASE / "build"
    build.mkdir()
    env = native_env()
    records = []
    records.append(run("compiler", ["/usr/bin/clang++", "--version"], build, env))
    flags = ["--prefix=" + str(BASE / "install")] + expected["configureFlags"]
    records.append(run("configure", [str(source / "icu/source/runConfigureICU"), "MacOSX", *flags], build, env))
    records.append(run("make", ["/usr/bin/make", "-j2"], build, env))
    records.append(run("install", ["/usr/bin/make", "-j2", "install"], build, env))
    archives = {}
    for name in ("libicuuc.a", "libicui18n.a", "libicudata.a"):
        file = BASE / "install/lib" / name
        archives[name] = {"sha256": sha(file), "bytes": file.stat().st_size}
    require(not list((BASE / "install/lib").glob("*.dylib")), "unexpected ICU shared libraries")
    require(data.read_bytes() in (BASE / "install/lib/libicudata.a").read_bytes(), "static archive does not contain the exact whole release data")
    stamp = {"root": str(ROOT), "host": args.host, "target": args.target, "prepareSha256": sha(__file__), "pinsSha256": sha(PIN_FILE), "sourceSha512": expected["sourceSha512"], "dataSha256": expected["dataSha256"], "bindings": binding_config, "flags": expected["configureFlags"], "compilerSha256": sha("/usr/bin/clang++"), "archives": archives, "nativeCommands": records, "qualification": "Build-scoped exact source/data/static inputs, not a safe runtime-version guard or cross-platform release proof."}
    (BASE / "prepared.json").write_text(json.dumps(stamp, indent=2) + "\n")
    verify(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "verify"))
    parser.add_argument("--host", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--source-archive")
    parser.add_argument("--cargo", default="cargo")
    args = parser.parse_args()
    if args.operation == "prepare":
        require(args.source_archive is not None, "prepare requires --source-archive")
        prepare(args)
    else:
        verify(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(f"ICU77 preparation refused: {error}", file=sys.stderr)
        raise SystemExit(1)
