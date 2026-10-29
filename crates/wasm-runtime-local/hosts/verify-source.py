#!/usr/bin/env python3
"""Replay the original fixture and freeze its portable Node wrapper before hosts."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-ref', required=True)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    original = subprocess.check_output(['git', 'show', f'{args.source_ref}:crates/wasm-runtime-local/source.mts'], cwd=REPO)
    (evidence / 'original-fixture.mts').write_bytes(original)
    command = [str(REPO / 'node_modules/.bin/esbuild'), '--bundle', '--platform=node', '--format=esm', '--sourcefile=original-fixture.mts', '--loader=ts', f'--outfile={evidence / "original.mjs"}']
    build = subprocess.run(command, input=original, cwd=ROOT.parent, capture_output=True)
    (evidence / 'original-build.stdout').write_bytes(build.stdout)
    (evidence / 'original-build.stderr').write_bytes(build.stderr)
    assert build.returncode == 0, build.stderr
    run = subprocess.run(['node', str(evidence / 'original.mjs')], cwd=REPO, capture_output=True, timeout=10)
    (evidence / 'original-run.stdout').write_bytes(run.stdout)
    (evidence / 'original-run.stderr').write_bytes(run.stderr)
    assert run.returncode == 0 and run.stderr == b''
    current = evidence / 'current'
    producer = ['python3', str(ROOT.parent / 'prove.py'), '--source-only', '--evidence', str(current)]
    checked = subprocess.run(producer, cwd=REPO, capture_output=True, timeout=15)
    (evidence / 'current-producer.stdout').write_bytes(checked.stdout)
    (evidence / 'current-producer.stderr').write_bytes(checked.stderr)
    assert checked.returncode == 0
    stdout = (current / 'run.stdout').read_bytes()
    assert stdout == run.stdout, 'portable Node wrapper changed original fixture stdout'
    value = json.loads(stdout)
    assert len(value) == 7 and sum(len(row.get('trace', [])) for row in value.values()) == 129
    result = {'passed': True, 'original_source_ref': args.source_ref, 'original_fixture_sha256': hashlib.sha256(original).hexdigest(), 'stdout_byte_equal': True, 'complete_objects_equal': True, 'stdout_sha256': hashlib.sha256(stdout).hexdigest(), 'observation_objects': 7, 'trace_entries': 129, 'commands': {'original': command, 'current': producer}, 'qualification': 'The portable fixture/Node wrapper is adapted. Its complete output is replayed against the original fixture with the unchanged frozen Source library; this does not call the wrapper untouched.'}
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'baseline': str(current)}))


if __name__ == '__main__':
    main()
