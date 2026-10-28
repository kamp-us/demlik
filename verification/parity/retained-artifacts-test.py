"""Metadata-only contract checks using an actual saved Cargo producer.

The prior combined run lost executable bytes after successful comparisons.
These checks exercise snapshot admission, not the comparison bodies or Cargo.
Each refusal corrupts one independent provenance boundary; no fake positive
Cargo events, extra shared cases, or test-only production API is introduced.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import pathlib
import shutil
import sys
import unittest


def sha(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


class SnapshotAdmission(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.evidence = arguments.output / "fixtures"
        cls.evidence.mkdir(parents=True, exist_ok=True)
        cls.original = json.loads(arguments.producer.read_text())
        cls.root = pathlib.Path(cls.original["actualArtifact"].split("/target/", 1)[0])
        cls.sources = json.loads(arguments.source_manifest.read_text())
        cls.snapshot = cls.evidence / "actual-selected.bin"
        shutil.copy2(cls.original["binary"], cls.snapshot)
        assert sha(cls.snapshot) == cls.original["binarySha256"]
        cls.cargo_bytes = pathlib.Path(cls.original["cargoJson"]).read_bytes()
        assert hashlib.sha256(cls.cargo_bytes).hexdigest() == cls.original["cargoJsonSha256"]

    def setUp(self):
        for file in self.evidence.glob("*.artifacts.json"):
            file.unlink()
        self.proof = copy.deepcopy(self.original)
        self.proof["binary"] = str(self.snapshot)
        self.proof["cargoJson"] = str(self.evidence / "helper.cargo.jsonl")
        pathlib.Path(self.proof["cargoJson"]).write_bytes(self.cargo_bytes)
        # Rebase only saved metadata and immutable byte copies, never Cargo events.
        for name, library in self.proof["libraries"].items():
            if "retainedPath" in library:
                copied = self.evidence / "libraries" / (name + ".rlib.gz")
                copied.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(library["retainedPath"], copied)
                library["retainedPath"] = str(copied)
        self.sidecar = self.evidence / "helper.artifacts.json"
        self.report = self.evidence / "comparison.json"

    def write(self, value=None, digest=None, field=None, declared=True):
        self.sidecar.write_text(json.dumps(self.proof))
        report = {"binarySha256": self.proof["binarySha256"] if value is None else value,
                  "producer": self.proof if declared else None}
        self.report.write_text(json.dumps(report))
        return [{"report": str(self.report), "reportSha256": sha(self.report),
                 "field": "/binarySha256", "fieldPath": field or ["binarySha256"],
                 "sha256": digest or self.proof["binarySha256"]}]

    def admit(self, claims):
        return owner.retained_snapshots(self.root, self.evidence, claims, self.sources)

    def test_actual_snapshot_survives_missing_original(self):
        """A real immutable copy remains useful after its original target is retired."""
        self.assertFalse(pathlib.Path(self.proof["actualArtifact"]).exists())
        records = self.admit(self.write())
        self.assertEqual(list(records), [self.original["binarySha256"]])
        self.assertEqual(records[self.original["binarySha256"]]["preserved"], str(self.snapshot))
        for name, library in self.proof["libraries"].items():
            selected = records[self.original["binarySha256"]]["librarySnapshots"][name]
            self.assertEqual(selected["bytesRetained"], "retainedPath" in library)
            if selected["bytesRetained"]:
                self.assertEqual(selected["compilerArtifact"], library["artifact"])
                self.assertEqual(selected["preservedSha256"], library["retainedSha256"])

    def test_legacy_metadata_never_claims_missing_library_bytes(self):
        """Old sidecars stay useful without inventing snapshots they never made."""
        for library in self.proof["libraries"].values():
            for key in ("artifact", "retainedPath", "retainedSha256", "retainedEncoding", "source", "manifest"):
                library.pop(key, None)
        record = next(iter(self.admit(self.write()).values()))
        self.assertFalse(record["allDeclaredLibraryBytesRetained"])
        self.assertTrue(all(not item["bytesRetained"] for item in record["librarySnapshots"].values()))

    def selected_library(self):
        library = next(iter(self.proof["libraries"].values()))
        if "retainedPath" not in library:
            self.skipTest("Legacy input has no immediate library snapshot")
        return library

    def test_decoded_library_bytes_must_match_selected_digest(self):
        library = self.selected_library()
        library["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "decoded library snapshot differs"):
            self.admit(self.write())

    def test_full_library_event_must_be_original(self):
        library = self.selected_library()
        library["artifact"]["fresh"] = not library["artifact"]["fresh"]
        with self.assertRaisesRegex(ValueError, "declared library event differs"):
            self.admit(self.write())

    def test_library_source_must_match_frozen_workspace(self):
        library = self.selected_library()
        library["source"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "library source digest differs"):
            self.admit(self.write())

    def test_snapshot_digest_refuses_changed_bytes(self):
        """A producer's digest cannot bless different actual snapshot bytes."""
        self.proof["binarySha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed snapshot"):
            self.admit(self.write())

    def test_executable_must_be_selected_by_real_event(self):
        """A valid snapshot alone does not prove another target was selected."""
        self.proof["actualArtifact"] += ".unselected"
        with self.assertRaisesRegex(ValueError, "one actual executable event"):
            self.admit(self.write())

    def test_report_digest_refuses_changed_report(self):
        """The reader cannot silently bind a different report after capture."""
        claims = self.write()
        self.report.write_text(self.report.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "comparison report changed"):
            self.admit(claims)

    def test_ledger_digest_must_equal_actual_report_value(self):
        """A forged claim cannot select a real unrelated snapshot."""
        claims = self.write(value="0" * 64, digest=self.original["binarySha256"])
        with self.assertRaisesRegex(ValueError, "comparison field digest differs"):
            self.admit(claims)

    def test_field_path_must_exist_in_actual_report(self):
        """Diagnostic slash labels cannot substitute for real JSON keys."""
        with self.assertRaisesRegex(ValueError, "field path does not exist"):
            self.admit(self.write(field=["not/the/key"]))

    def test_declared_missing_sidecar_refuses(self):
        """Default-build provenance cannot disappear behind the target scan."""
        claims = self.write()
        self.sidecar.unlink()
        with self.assertRaisesRegex(ValueError, "missing declared producer sidecar"):
            self.admit(claims)

    def test_source_digest_must_match_captured_workspace(self):
        """An entry from another source snapshot cannot inherit current proof."""
        events = [json.loads(line) for line in self.cargo_bytes.splitlines()]
        event = next(v for v in events if v.get("executable") == self.proof["actualArtifact"])
        self.proof["source"] = {"path": event["target"]["src_path"], "sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "source digest differs"):
            self.admit(self.write())

    def test_explicit_binary_without_producer_gets_no_fake_event(self):
        """Caller-owned binary hashes remain unbound without actual provenance."""
        claims = self.write(declared=False)
        self.sidecar.unlink()
        self.assertEqual(self.admit(claims), {})

    def test_duplicate_producer_reuses_one_existing_copy(self):
        """Two report references do not make two executable copies necessary."""
        claims = self.write()
        duplicate = copy.deepcopy(self.proof)
        duplicate["cargoJson"] = str(self.evidence / "second.cargo.jsonl")
        pathlib.Path(duplicate["cargoJson"]).write_bytes(self.cargo_bytes)
        (self.evidence / "second.artifacts.json").write_text(json.dumps(duplicate))
        records = self.admit(claims)
        self.assertEqual(len(records), 1)
        self.assertEqual(next(iter(records.values()))["preserved"], str(self.snapshot))
        self.assertFalse((self.evidence / "artifacts").exists())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--producer", type=pathlib.Path, required=True)
    parser.add_argument("--source-manifest", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--owner", type=pathlib.Path, default=pathlib.Path(__file__).with_name("retained_artifacts.py"))
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("retained_artifacts", arguments.owner)
    owner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owner)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(SnapshotAdmission)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    (arguments.output / "result.json").write_text(json.dumps({"tests": result.testsRun,
        "failures": [test.id() for test, _ in result.failures], "errors": [test.id() for test, _ in result.errors],
        "producer": str(arguments.producer), "producerSha256": sha(arguments.producer),
        "module": str(arguments.owner), "moduleSha256": sha(arguments.owner),
        "newSharedCredit": 0, "sourceNativeCargoInvocations": 0}, indent=2) + "\n")
    sys.exit(not result.wasSuccessful())
