"""Admit the existing Cargo helper's immutable snapshots before target cleanup."""
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


def retained_snapshots(root, evidence, claims, source_hashes):
    root, evidence = pathlib.Path(root), pathlib.Path(evidence)
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
        package = pathlib.Path(event["manifest_path"])
        require(package in (root / "crates/tea/Cargo.toml", root / "crates/parity/Cargo.toml"), f"unexpected producer package: {package}")
        kind = "bin" if package.parent.name == "parity" else ("test" if event["profile"]["test"] else "example")
        require(kind in event["target"]["kind"], f"wrong executable kind: {sidecar}")
        command = proof["command"]
        require("--" + kind in command and command[command.index("--" + kind) + 1] == event["target"]["name"], f"target not requested by Cargo command: {sidecar}")
        require("-p" in command and command[command.index("-p") + 1] == ("demlik-parity" if kind == "bin" else "demlik-tea"), f"package not requested by Cargo command: {sidecar}")
        source = pathlib.Path(event["target"]["src_path"])
        require(source.is_relative_to(root), f"producer source outside workspace: {source}")
        relative = str(source.relative_to(root))
        require(relative in source_hashes, f"producer source not in frozen source manifest: {source}")
        if "source" in proof:
            require(proof["source"] == {"path": str(source), "sha256": source_hashes[relative]}, f"producer source digest differs: {sidecar}")
        expected_libraries = {"demlik_tea"} | ({"demlik_code_graph"} if kind == "bin" else set())
        require(expected_libraries <= proof["libraries"].keys(), f"missing required library metadata: {sidecar}")
        for name, library in proof["libraries"].items():
            matches = [row for row in events if row["target"]["name"] == name and "lib" in row["target"]["kind"] and library["path"] in row["filenames"]]
            require(len(matches) == 1 and matches[0]["package_id"] == library["packageId"] and matches[0]["features"] == library["features"], f"library metadata differs from Cargo event: {sidecar}")
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
                  "libraryByteRetention": "Metadata checked against actual Cargo events; this admission does not claim missing library bytes are retained."}
        if digest not in records:
            records[digest] = record
        processed.add(sidecar)
    require(set(embedded) <= processed, "declared Cargo producer was not admitted")
    return records
