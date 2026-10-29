#!/usr/bin/env python3
"""Actual SQLite SDK event-store parity, including process restart and owned work."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('paired', ROOT / 'prove-paired.py')
paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paired)
base_runtime_errors = paired.runtime_errors


def runtime_errors(raw):
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    errors = base_runtime_errors(clean)
    errors += [line for line in clean.splitlines() if "[ERROR]" in line or "Critical Error:" in line]
    return list(dict.fromkeys(errors))


paired.runtime_errors = runtime_errors


def wire(value):
    return json.dumps(value, separators=(',', ':'))


def model(count):
    return {'type': 'counting', 'count': count}


def event(by):
    return {'type': 'inc', 'by': by}


def check(value, bys, count, snapshot, outcome=None, ready=1, malformed=False):
    cells = {'unrelated/keep': 'kept'}
    cells.update({f'@@es/evt/{seq:016}': wire(event(by)) for seq, by in enumerate(bys, 1)})
    if bys:
        cells['@@es/meta'] = wire({'lastSeq': len(bys)})
    if snapshot:
        cells['@@es/snapshot'] = wire({'seq': snapshot[0], 'state': model(snapshot[1])})
    if malformed:
        cells['@@es/evt/0000000000000006'] = '{broken}'
        expected = {'outcome': {'kind': 'json'}, 'ready_calls': ready, 'cells': sorted(cells.items())}
    else:
        rows = [{'seq': seq, 'event': event(by)} for seq, by in enumerate(bys, 1)]
        expected = {'model': model(count), 'outcome': outcome, 'ready_calls': ready,
                    'events': rows, 'window': [row for row in rows if 2 <= row['seq'] <= 4],
                    'cells': sorted(cells.items())}
    expected['cells'] = [list(row) for row in expected['cells']]
    assert value == expected, {'expected': expected, 'actual': value}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--source-only', action='store_true')
    parser.add_argument('--source-freeze', type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    artifacts = evidence / 'artifacts'
    artifacts.mkdir()
    frozen_files = ['crates/cloudflare-local/events.ts', 'crates/cloudflare-local/source.ts']
    freeze = {file: paired.digest(paired.REPO / file) for file in frozen_files}
    if args.source_freeze:
        assert freeze == json.loads(args.source_freeze.read_text()), 'Source consumer changed after baseline'
    paired.write(evidence / 'source-fixture-freeze.json', freeze)
    guard = subprocess.run(['git', 'diff', '--exit-code', paired.REFERENCE, '--', 'packages/tea/src', 'packages/tea/package.json'], cwd=paired.REPO, capture_output=True)
    (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
    (evidence / 'frozen-source.stderr').write_bytes(guard.stderr)
    assert guard.returncode == 0, 'frozen Source changed'
    source = artifacts / 'source.js'
    command = [str(ROOT / 'node_modules/.bin/esbuild'), str(ROOT / 'source.ts'), '--bundle', '--format=esm', '--platform=browser', f'--outfile={source}', f'--metafile={artifacts / "source-meta.json"}']
    build = subprocess.run(command, cwd=paired.REPO, capture_output=True)
    (artifacts / 'source-build.stdout').write_bytes(build.stdout)
    (artifacts / 'source-build.stderr').write_bytes(build.stderr)
    paired.write(artifacts / 'source-producer.json', {'command': command, 'status': build.returncode})
    assert build.returncode == 0
    hosts = [paired.Host('source', source, 'SourceJobs', evidence)]
    if not args.source_only:
        shutil.copytree(ROOT / 'build', artifacts / 'rust')
        hosts.append(paired.Host('rust', artifacts / 'rust/index.js', 'Jobs', evidence))
    inputs = list(json.loads((artifacts / 'source-meta.json').read_text())['inputs'])
    inputs += ['crates/cloudflare-local/prove-events.py', 'crates/cloudflare-local/prove-paired.py', 'crates/cloudflare-local/Cargo.toml', 'crates/cloudflare-local/package-lock.json', 'Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', 'crates/tea/Cargo.toml']
    inputs += [str(file.relative_to(paired.REPO)) for file in (ROOT / 'src').glob('*.rs')]
    inputs += [str(file.relative_to(paired.REPO)) for file in (paired.REPO / 'crates/tea/src').rglob('*.rs')]
    for relative in set(inputs):
        target = artifacts / 'inputs' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(paired.REPO / relative, target)
    result = {'passed': False, 'reference': paired.REFERENCE, 'backend': 'actual local SQLite SDK',
              'commands': {host.name: host.command for host in hosts}, 'observations': []}

    def observe(command, bys, count, snapshot=None, outcome=None, ready=1, malformed=False):
        observations = {}
        for host in hosts:
            status, value = host.request('/events', command)
            assert status == 200, (host.name, command, status, value)
            check(value, bys, count, snapshot, outcome, ready, malformed)
            observations[host.name] = value
        if len(hosts) == 2:
            assert observations['source'] == observations['rust']
        result['observations'].append({'command': command, 'hosts': observations})
        return observations

    try:
        for host in hosts:
            host.start(1)
        observe({'action': 'seed'}, [], 0)
        observe({'action': 'state'}, [], 0)
        observe({'action': 'snapshot'}, [], 0, outcome={'snapshot': False})
        observe({'action': 'step', 'by': 1}, [1], 1)
        observe({'action': 'step', 'by': 2}, [1, 2], 3)
        observe({'action': 'drop-step', 'by': 3}, [1, 2, 3], 6, (3, 6), {'kind': 'dropped-append', 'completed': True})
        observe({'action': 'step', 'by': 4}, [1, 2, 3, 4], 10, (3, 6))
        observe({'action': 'wrong-snapshot'}, [1, 2, 3, 4], 13, (2, 6))
        observe({'action': 'restore-snapshot'}, [1, 2, 3, 4], 10, (3, 6))
        observe({'action': 'stale-tail'}, [1, 2, 3, 40], 46, (3, 6))
        observe({'action': 'restore-tail'}, [1, 2, 3, 4], 10, (3, 6))
        observe({'action': 'malformed'}, [1, 2, 3, 4], 10, (3, 6), malformed=True)
        observe({'action': 'restore-row'}, [1, 2, 3, 4], 10, (3, 6))
        observe({'action': 'sdk-failure'}, [1, 2, 3, 4], 10, (3, 6), {'kind': 'storage', 'operation': 'get', 'original_error': True})
        observe({'action': 'snapshot'}, [1, 2, 3, 4], 10, (4, 10), {'snapshot': True})
        observe({'action': 'snapshot'}, [1, 2, 3, 4], 10, (4, 10), {'snapshot': False})
        before = observe({'action': 'step', 'by': 5}, [1, 2, 3, 4, 5], 15, (4, 10))
        for host in hosts:
            host.check_runtime()
            host.stop()
            host.start(2)
        recovered = observe({'action': 'state'}, [1, 2, 3, 4, 5], 15, (4, 10))
        assert before == recovered, 'process restart changed recovered snapshot + ordered tail'
        observe({'action': 'state'}, [1, 2, 3, 4, 5], 15, (4, 10))
        observe({'action': 'drop-snapshot'}, [1, 2, 3, 4, 5], 15, (5, 15), {'kind': 'dropped-snapshot', 'completed': True})
        observe({'action': 'step', 'by': 6}, list(range(1, 7)), 21, (5, 15))
        observe({'action': 'step', 'by': 7}, list(range(1, 8)), 28, (5, 15))
        observe({'action': 'step', 'by': 8}, list(range(1, 9)), 36, (8, 36))
        observe({'action': 'delete'}, [], 0, ready=2)
        observe({'action': 'step', 'by': 9}, [9], 9, ready=2)
        for host in hosts:
            before_invalid = host.request('/events', {'action': 'state'})
            for invalid in [{}, {'action': 'step'}, {'action': 'state', 'by': 1}, {'action': 'step', 'by': 1.5}]:
                assert host.request('/events', invalid)[0] == 400
            assert host.request('/events', {'action': 'state'}) == before_invalid
            host.check_runtime()
            host.stop()
            host.start(3)
        observe({'action': 'state'}, [9], 9)
        for host in hosts:
            host.check_runtime()
        result['passed'] = True
        result['qualifications'] = ['cmdless Machine only; no arbitrary command effect deduplication claim',
                                    'delete is consumer-owned namespace cleanup, not an event store method',
                                    'actual process restart, no cloud eviction/deployment/crash atomicity claim',
                                    'wrong-seq and stale-tail controls deliberately alter recovered result; no validation guarantee implied']
    finally:
        for host in hosts:
            host.close()
        result['runtime_checks'] = {host.name: host.runtime_checks for host in hosts}
        result['artifact_sha256'] = {str(file.relative_to(artifacts)): paired.digest(file) for file in artifacts.rglob('*') if file.is_file()}
        paired.write(evidence / 'result.json', result)
    print(json.dumps({'passed': True, 'evidence': str(evidence), 'hosts': [host.name for host in hosts]}))


if __name__ == '__main__':
    main()
