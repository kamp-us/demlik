#!/usr/bin/env python3
"""Compare an actual compiled generic Wasm Actor with frozen Source on Node."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
REFERENCE = '75de37ea01a81cd7949e6275b7ee9cfdeb4e312d'


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def timer_clean(stats):
    assert stats['active'] == [] and stats['errors'] == [], stats


def freeze_source(evidence):
    command = [str(REPO / 'node_modules/.bin/esbuild'), str(ROOT / 'source.mts'), '--bundle', '--platform=node', '--format=esm', f'--outfile={evidence / "source.mjs"}', f'--metafile={evidence / "meta.json"}']
    built = subprocess.run(command, cwd=REPO, capture_output=True)
    (evidence / 'build.stdout').write_bytes(built.stdout)
    (evidence / 'build.stderr').write_bytes(built.stderr)
    assert built.returncode == 0
    run = subprocess.run(['node', str(evidence / 'source.mjs')], cwd=REPO, capture_output=True, timeout=10)
    (evidence / 'run.stdout').write_bytes(run.stdout)
    (evidence / 'run.stderr').write_bytes(run.stderr)
    assert run.returncode == 0 and run.stderr == b''
    write(evidence / 'observations.json', json.loads(run.stdout))
    inputs = list(json.loads((evidence / 'meta.json').read_text())['inputs'])
    inputs += ['crates/wasm-runtime-local/tsconfig.source.json']
    hashes = {}
    for relative in inputs:
        file = REPO / relative
        hashes[relative] = digest(file)
        if relative.startswith(('packages/tea/', 'crates/wasm-runtime-local/')):
            destination = evidence / 'inputs' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, destination)
    write(evidence / 'freeze.json', hashes)
    write(evidence / 'producer.json', {'build': command, 'source_status': run.returncode,
                                      'source_reference': REFERENCE,
                                      'runtime_source_sha256': {str(file.relative_to(REPO)): digest(file) for file in (REPO / 'crates/tea/src/runtime').glob('*.rs')}})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', type=Path)
    parser.add_argument('--source-baseline', type=Path)
    parser.add_argument('--source-only', action='store_true')
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--host-seams-only', action='store_true')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    if args.source_only:
        guard = subprocess.run(['git', 'diff', '--exit-code', REFERENCE, '--', 'packages/tea/src', 'packages/tea/package.json'], cwd=REPO, capture_output=True)
        (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
        assert guard.returncode == 0
        freeze_source(evidence)
        print(json.dumps({'passed': True, 'source_only': True, 'evidence': str(evidence)}))
        return
    if args.package is None or args.source_baseline is None:
        parser.error('--package and --source-baseline are required for Wasm execution')
    package = evidence / 'artifacts' / 'wasm-node'
    shutil.copytree(args.package.resolve(), package)
    (package / 'package.json').write_text('{"type":"commonjs"}\n')
    baseline = args.source_baseline.resolve()
    expected_hashes = json.loads((baseline / 'freeze.json').read_text())
    actual_hashes = {relative: digest(REPO / relative) for relative in expected_hashes}
    assert expected_hashes == actual_hashes, 'frozen Source producer input changed'
    guard = subprocess.run(['git', 'diff', '--exit-code', REFERENCE, '--', 'packages/tea/src', 'packages/tea/package.json'], cwd=REPO, capture_output=True)
    (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
    (evidence / 'frozen-source.stderr').write_bytes(guard.stderr)
    assert guard.returncode == 0, 'frozen Source library changed'
    result = {'passed': False, 'profile': 'Node22 actual generic Rust Wasm Actor', 'reference': REFERENCE, 'source_hashes': actual_hashes, 'executions': {}}
    inputs = list((REPO / 'crates/tea/src').rglob('*.rs'))
    inputs += list((ROOT / 'src').glob('*.rs'))
    inputs += [ROOT / 'Cargo.toml', ROOT / 'prove.py', ROOT / 'probe.mjs', ROOT / 'source.mts', ROOT / 'source-smoke.mts', ROOT / 'tsconfig.source.json', REPO / 'Cargo.toml', REPO / 'Cargo.lock', REPO / 'crates/tea/Cargo.toml', REPO / 'rust-toolchain.toml']
    for file in inputs:
        destination = evidence / 'inputs' / file.relative_to(REPO)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)

    def execute(name, command):
        began = time.time_ns() // 1_000_000
        run = subprocess.run(command, cwd=REPO, capture_output=True, timeout=10)
        ended = time.time_ns() // 1_000_000
        (evidence / f'{name}.stdout').write_bytes(run.stdout)
        (evidence / f'{name}.stderr').write_bytes(run.stderr)
        result['executions'][name] = {'command': command, 'status': run.returncode, 'began_ms': began, 'ended_ms': ended}
        assert run.returncode == 0, (name, run.stderr.decode(), run.stdout.decode())
        assert run.stderr == b'', (name, run.stderr.decode())
        return json.loads(run.stdout)

    def wasm(action):
        command = ['node', str(ROOT / 'probe.mjs'), str(package / 'runtime.js'), action]
        return execute(action, command)['value']

    try:
        if not args.host_seams_only:
            source = evidence / 'artifacts' / 'source.mjs'
            build = [str(REPO / 'node_modules/.bin/esbuild'), str(ROOT / 'source.mts'), '--bundle', '--platform=node', '--format=esm', f'--outfile={source}', f'--metafile={evidence / "source-meta.json"}']
            built = subprocess.run(build, cwd=REPO, capture_output=True)
            (evidence / 'source-build.stdout').write_bytes(built.stdout)
            (evidence / 'source-build.stderr').write_bytes(built.stderr)
            assert built.returncode == 0
            source_value = execute('source', ['node', str(source)])
            assert source_value == json.loads((baseline / 'observations.json').read_text()), 'Source baseline drifted'
            clock = wasm('default_clock_probe')
            assert math.isfinite(clock) and clock == math.floor(clock)
            clock_run = result['executions']['default_clock_probe']
            assert clock_run['began_ms'] - 2 <= clock <= clock_run['ended_ms'] + 2
            assert json.loads(wasm('smoke')) == {'count': 1}
            actual = json.loads(wasm('fixture'))
            assert actual['observations'] == source_value, {'source': source_value, 'rust': actual['observations']}
            assert source_value['a']['model']['count'] == 28 and source_value['b']['model']['count'] == 91
            for stats in actual['timers'].values():
                timer_clean(stats)
            assert actual['timers']['a']['arms'] == actual['timers']['b']['arms'] == [10000, 4]
            assert actual['timers']['a']['clears'] == actual['timers']['b']['clears'] == [1, 2]
            assert actual['timers']['drain']['arms'] == actual['timers']['dispose']['arms'] == [15]
            result.update(source=source_value, rust=actual, default_clock=clock)
        seams = json.loads(wasm('host_seams'))
        for row in seams.values():
            timer_clean(row['timers'])
        assert seams['dropped_stop']['timers']['clears'] == [1]
        assert seams['dropped_stop']['timers']['arms'] == [15]
        assert seams['dropped_stop']['gate'] == 'Closed'
        for name, gate in [('drain_arm_failure', 'Abandoned'), ('dispose_arm_failure', 'Closed')]:
            assert seams[name]['original_cause'] is True and seams[name]['gate'] == gate
            reports = seams[name]['reports']
            assert {'name': 'TimerError', 'phase': 'discard'} in reports
            assert all(row['name'] not in ['DrainTimeoutNotice', 'DisposeTimeoutNotice'] for row in reports)
        assert seams['effect_scope']['count'] == 2 and seams['effect_scope']['closed'] is True
        telemetry = seams['clock_telemetry']['events']
        assert len(telemetry) == 1 and telemetry[0]['seq'] == 1 and telemetry[0]['msgType'] == 'add'
        execution = result['executions']['host_seams']
        assert execution['began_ms'] - 2 <= telemetry[0]['at'] <= execution['ended_ms'] + 2
        result.update(passed=True, host_seams=seams)
        result['qualifications'] = ['Node22 only; actual browser and Workers execution remain separate',
                                    'generic Actor and a minimal Effect scope, not high-level Agent.run',
                                    'fixture Store is an asynchronous in-process string port, not durable disk/SDK storage',
                                    'complete logical traces and exact store strings compare; actual timestamps/latency do not',
                                    'Source detach uses its existing internal detachWorkOf seam; no Source library change',
                                    '15ms teardown timeout is asserted through a loose lower bound, no exact-clock claim']
    finally:
        result['sha256'] = {str(file.relative_to(evidence)): digest(file) for file in evidence.rglob('*') if file.is_file()}
        write(evidence / 'result.json', result)
    print(json.dumps({'passed': True, 'evidence': str(evidence)}))


if __name__ == '__main__':
    main()
