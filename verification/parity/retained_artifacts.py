"""Admit the existing Cargo helper's immutable snapshots before target cleanup."""
import gzip
import hashlib
import json
import pathlib
import shutil


def sha(file):
    with pathlib.Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _library_snapshot(root, evidence, name, library, event, source_hashes):
    actual = pathlib.Path(library["path"])
    require(actual.resolve().is_relative_to((root / "target").resolve()), f"library outside owning default target: {actual}")
    result = {"actualArtifact": str(actual), "sha256": library["sha256"],
              "compilerArtifact": event, "bytesRetained": False}
    if "artifact" in library:
        require(library["artifact"] == event, f"declared library event differs: {name}")
    if not any(key.startswith("retained") for key in library):
        result["qualification"] = "Legacy metadata only; no retained library bytes claimed."
        return result
    required = {"artifact", "retainedPath", "retainedSha256", "retainedEncoding", "source", "manifest"}
    require(required <= library.keys(), f"incomplete retained library metadata: {name}")
    require(library["retainedEncoding"] == "gzip", f"unsupported library snapshot encoding: {name}")
    snapshot = pathlib.Path(library["retainedPath"])
    require(snapshot.resolve().is_relative_to(evidence.resolve()) or snapshot.resolve().is_relative_to((root / "target/parity").resolve()), f"library snapshot outside owning evidence: {snapshot}")
    require(snapshot.is_file() and sha(snapshot) == library["retainedSha256"], f"missing or changed library snapshot: {snapshot}")
    decoded = gzip.decompress(snapshot.read_bytes())
    require(hashlib.sha256(decoded).hexdigest() == library["sha256"], f"decoded library snapshot differs: {name}")
    provenance = {}
    for key, source in (("source", pathlib.Path(event["target"]["src_path"])), ("manifest", pathlib.Path(event["manifest_path"]))):
        require(library[key]["path"] == str(source), f"library {key} path differs: {name}")
        if source.is_relative_to(root):
            relative = str(source.relative_to(root))
            require(relative in source_hashes and source_hashes[relative] == library[key]["sha256"], f"library {key} digest differs from frozen source: {name}")
            provenance[key] = {**library[key], "validation": "frozen workspace source manifest"}
        else:
            # A dependency's event and retained output do not archive its source tree.
            provenance[key] = {**library[key], "validation": "producer-declared third-party source; not frozen workspace source"}
    if snapshot.resolve().is_relative_to(evidence.resolve()):
        preserved = snapshot
    else:
        preserved = evidence / "artifacts/libraries" / library["sha256"] / (actual.name + ".gz")
        preserved.parent.mkdir(parents=True, exist_ok=True)
        if not preserved.exists():
            shutil.copy2(snapshot, preserved)
        require(sha(preserved) == library["retainedSha256"], f"changed library snapshot copy: {preserved}")
    result.update({"bytesRetained": True, "preserved": str(preserved), "encoding": "gzip",
                   "preservedSha256": library["retainedSha256"], "decodedBytes": len(decoded),
                   "sourceProvenance": provenance, "allDependenciesClaimed": False})
    return result


def retained_snapshots(root, evidence, claims, source_hashes):
    root, evidence = pathlib.Path(root), pathlib.Path(evidence)
    packages = {
        root / "crates/tea/Cargo.toml": ("demlik-tea", {"demlik_tea"}),
        root / "crates/code-graph/Cargo.toml": ("demlik-code-graph", {"demlik_code_graph"}),
        root / "crates/parity/Cargo.toml": ("demlik-parity", {"demlik_tea", "demlik_code_graph"}),
    }
    library_packages = {"demlik_tea": root / "crates/tea/Cargo.toml",
                        "demlik_code_graph": root / "crates/code-graph/Cargo.toml"}
    wanted = {claim["sha256"] for claim in claims}
    reports, embedded = {}, {}

    def producers(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("producer", "cargoArtifacts") and isinstance(item, dict) and "cargoJson" in item:
                    yield item
                yield from producers(item)
        elif isinstance(value, list):
            for item in value:
                yield from producers(item)

    for claim in claims:
        report = pathlib.Path(claim["report"])
        require(report.is_file(), f"missing comparison report: {report}")
        if report not in reports:
            digest = sha(report)
            require(digest == claim["reportSha256"], f"comparison report changed: {report}")
            reports[report] = {"sha256": digest, "value": json.loads(report.read_text())}
            for producer in producers(reports[report]["value"]):
                require("binarySha256" in producer, f"incomplete Cargo producer: {report}")
                if producer["binarySha256"] in wanted:
                    cargo = pathlib.Path(producer["cargoJson"])
                    require(cargo.name.endswith(".cargo.jsonl"), f"invalid Cargo log name: {cargo}")
                    sidecar = cargo.with_name(cargo.name[:-len(".cargo.jsonl")] + ".artifacts.json")
                    require(sidecar.is_file(), f"missing declared producer sidecar: {sidecar}")
                    prior = embedded.setdefault(sidecar, producer)
                    require(prior == producer, f"conflicting declared producer: {sidecar}")
        require(reports[report]["sha256"] == claim["reportSha256"], f"conflicting comparison report digest: {report}")
        value = reports[report]["value"]
        try:
            for key in claim["fieldPath"]:
                value = value[key]
        except (KeyError, IndexError, TypeError) as cause:
            raise ValueError(f"comparison field path does not exist: {report}") from cause
        require(value == claim["sha256"], f"comparison field digest differs: {report}")

    records, processed = {}, set()
    sidecars = set(embedded) | set(evidence.rglob("*.artifacts.json")) | set((root / "target/parity").rglob("*.artifacts.json"))
    for sidecar in sorted(sidecars):
        proof = json.loads(sidecar.read_text())
        # Other verifier artifact formats are not this helper's producer contract.
        if not isinstance(proof, dict) or "cargoJson" not in proof:
            continue
        required = {"command", "cargoJson", "cargoJsonSha256", "actualArtifact", "binary", "binarySha256", "libraries"}
        require(required <= proof.keys(), f"incomplete Cargo snapshot sidecar: {sidecar}")
        digest = proof["binarySha256"]
        if digest not in wanted:
            continue
        if sidecar in embedded:
            require(proof == embedded[sidecar], f"producer differs from comparison report: {sidecar}")
        snapshot, cargo = pathlib.Path(proof["binary"]), pathlib.Path(proof["cargoJson"])
        require(snapshot.resolve().is_relative_to(evidence.resolve()) or snapshot.resolve().is_relative_to((root / "target/parity").resolve()), f"snapshot outside owning evidence: {snapshot}")
        require(snapshot.is_file() and sha(snapshot) == digest, f"missing or changed snapshot: {snapshot}")
        require(cargo.is_file() and sha(cargo) == proof["cargoJsonSha256"], f"missing or changed Cargo log: {cargo}")
        actual = pathlib.Path(proof["actualArtifact"])
        require(actual.resolve().is_relative_to((root / "target").resolve()), f"executable outside owning default target: {actual}")
        events = []
        for line in cargo.read_text().splitlines():
            row = json.loads(line)
            if row.get("reason") == "compiler-artifact":
                events.append(row)
        selected = [event for event in events if event.get("executable") == str(actual) and str(actual) in event["filenames"]]
        require(len(selected) == 1, f"expected one actual executable event: {sidecar}")
        event = selected[0]
        if "driver" in proof:
            require(proof["driver"] == event, f"declared executable event differs: {sidecar}")
        package = pathlib.Path(event["manifest_path"])
        require(package in packages, f"unexpected producer package: {package}")
        package_name, expected_libraries = packages[package]
        kind = "bin" if package.parent.name == "parity" else ("test" if event["profile"]["test"] else "example")
        require(kind in event["target"]["kind"], f"wrong executable kind: {sidecar}")
        command = proof["command"]
        require("--" + kind in command and command[command.index("--" + kind) + 1] == event["target"]["name"], f"target not requested by Cargo command: {sidecar}")
        package_flag = "-p" if "-p" in command else "--package"
        require(package_flag in command and command[command.index(package_flag) + 1] == package_name, f"package not requested by Cargo command: {sidecar}")
        if "--features" in command:
            requested = command[command.index("--features") + 1].split(",")
            require(set(requested) <= set(event["features"]), f"requested features absent from Cargo selection: {sidecar}")
        source = pathlib.Path(event["target"]["src_path"])
        require(source.is_relative_to(root), f"producer source outside workspace: {source}")
        relative = str(source.relative_to(root))
        require(relative in source_hashes, f"producer source not in frozen source manifest: {source}")
        if "source" in proof:
            require(proof["source"] == {"path": str(source), "sha256": source_hashes[relative]}, f"producer source digest differs: {sidecar}")
        require(expected_libraries <= proof["libraries"].keys(), f"missing required library metadata: {sidecar}")
        libraries = {}
        for name, library in proof["libraries"].items():
            matches = [row for row in events if row["target"]["name"] == name and "lib" in row["target"]["kind"] and library["path"] in row["filenames"]]
            require(len(matches) == 1 and matches[0]["package_id"] == library["packageId"] and matches[0]["features"] == library["features"], f"library metadata differs from Cargo event: {sidecar}")
            if name in library_packages:
                require(pathlib.Path(matches[0]["manifest_path"]) == library_packages[name], f"library package differs from Cargo event: {sidecar}")
            libraries[name] = _library_snapshot(root, evidence, name, library, matches[0], source_hashes)
        bindings = [{"report": claim["report"], "reportSha256": claim["reportSha256"], "field": claim["field"], "fieldPath": claim["fieldPath"]} for claim in claims if claim["sha256"] == digest]
        if digest in records:
            preserved = pathlib.Path(records[digest]["preserved"])
            require(sha(preserved) == digest, f"conflicting retained bytes: {digest}")
        elif snapshot.resolve().is_relative_to(evidence.resolve()):
            preserved = snapshot
        else:
            preserved = evidence / "artifacts" / (digest + ".bin")
            preserved.parent.mkdir(parents=True, exist_ok=True)
            if not preserved.exists():
                shutil.copy2(snapshot, preserved)
            require(sha(preserved) == digest, f"changed external snapshot copy: {preserved}")
        record = {"actualArtifact": str(actual), "preserved": str(preserved), "sha256": digest, "bytes": snapshot.stat().st_size,
                  "compilerArtifact": event, "compilerLog": str(cargo), "compilerLogSha256": proof["cargoJsonSha256"],
                  "producerSidecar": str(sidecar), "producerSidecarSha256": sha(sidecar), "sourceSha256": source_hashes[relative],
                  "reportBindings": bindings, "selectionOnly": True, "originalCodeGenerationClaimed": False,
                  "librarySnapshots": libraries,
                  "allDeclaredLibraryBytesRetained": all(value["bytesRetained"] for value in libraries.values()),
                  "libraryByteRetention": "Each declared selected library is classified separately; legacy metadata does not claim retained bytes or all dependencies."}
        if digest not in records:
            records[digest] = record
        processed.add(sidecar)
    require(set(embedded) <= processed, "declared Cargo producer was not admitted")
    return records
