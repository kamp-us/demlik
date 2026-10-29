#!/usr/bin/env python3
"""Exercise real SDK transactions and frozen Source fencing on local SQLite DOs."""
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
paired.RUNTIME_ERRORS += ("cancelled SDK transaction failed", "failed to restore transaction fault control")
base_runtime_errors = paired.runtime_errors


def runtime_errors(raw):
    clean = re.sub(r"\x1b\[[0-9;]*m", "", raw)
    errors = base_runtime_errors(clean)
    errors += [line for line in clean.splitlines() if "[ERROR]" in line or "Critical Error:" in line]
    return list(dict.fromkeys(errors))


paired.runtime_errors = runtime_errors



def check(action, value):
    cells = dict(value['cells'])
    outcome = value['outcome']
    if action == 'reset':
        assert cells == {} and outcome is None
    elif action == 'commit':
        assert outcome == {'kind': 'commit', 'borrowed_result': True}
        assert cells == {'tx/commit/a': 'kept', 'tx/commit/b': 7, 'tx/commit/u': '\ud800', 'tx/other': False, 'tx/null': None}
    elif action == 'rollback':
        assert outcome == {'kind': 'body', 'original_error': True, 'borrowed_owner': True, 'payload': 41}
        assert cells == {'tx/commit/a': 'kept', 'tx/commit/b': 7, 'tx/commit/u': '\ud800', 'tx/other': False, 'tx/null': None}
    elif action == 'sdk-error':
        assert outcome['kind'] == 'sdk' and outcome['original_error'] is True
        assert 'roll' in outcome['message'].lower(), outcome
        assert cells == {'tx/commit/a': 'kept', 'tx/commit/b': 7, 'tx/commit/u': '\ud800', 'tx/other': False, 'tx/null': None}
    elif action in ('sdk-reject', 'commit-reject'):
        assert outcome == {'kind': action, 'original_error': True, 'body_ran': action == 'commit-reject', 'message': 'injected commit rejection' if action == 'commit-reject' else 'injected early SDK rejection'}
        assert cells == {'tx/commit/a': 'kept', 'tx/commit/b': 7, 'tx/commit/u': '\ud800', 'tx/other': False, 'tx/null': None}
    elif action == 'cancel':
        assert outcome == {'kind': 'cancelled'}
        assert cells == {'tx/commit/a': 'kept', 'tx/commit/b': 7, 'tx/commit/u': '\ud800', 'tx/other': False, 'tx/null': None}
    elif action == 'fenced':
        assert outcome == {'kind': 'fenced', 'version': 1, 'expected': 0, 'actual': 1, 'state': {'count': 1}}
        assert cells['tx/fenced'] == '{"count":1}' and cells['tx/fenced@@version'] == 1
    elif action == 'delete':
        assert outcome == {'kind': 'delete'}
        assert cells == {'tx/fenced': '{"count":1}', 'tx/fenced@@version': 1, 'tx/other': False, 'tx/null': None}
    elif action == 'inspect':
        assert outcome is None
        assert cells == {'tx/fenced': '{"count":1}', 'tx/fenced@@version': 1, 'tx/other': False, 'tx/null': None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--source-only', action='store_true')
    parser.add_argument('--source-freeze', type=Path)
    parser.add_argument('--stop-after', choices=['commit', 'rollback', 'sdk-error', 'sdk-reject', 'commit-reject', 'cancel', 'fenced', 'delete', 'inspect'], default='inspect')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    artifacts = evidence / 'artifacts'
    artifacts.mkdir()
    if args.source_freeze:
        expected = json.loads(args.source_freeze.read_text())
        actual = {relative: paired.digest(paired.REPO / relative) for relative in expected}
        paired.write(evidence / 'source-fixture-freeze.json', {'expected': expected, 'actual': actual})
        assert expected == actual, 'Source consumer fixture changed after freeze'
    guard = subprocess.run(['git', 'diff', '--exit-code', paired.REFERENCE, '--', 'packages/tea/src', 'packages/tea/package.json'], cwd=paired.REPO, capture_output=True)
    (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
    (evidence / 'frozen-source.stderr').write_bytes(guard.stderr)
    assert guard.returncode == 0, 'Source library changed'
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
    inputs += ['crates/cloudflare-local/prove-transactions.py', 'crates/cloudflare-local/prove-paired.py', 'crates/cloudflare-local/src/lib.rs', 'crates/cloudflare-local/Cargo.toml', 'crates/cloudflare-local/package-lock.json', 'Cargo.lock']
    inputs += [str(file.relative_to(paired.REPO)) for file in (ROOT / 'src').glob('*.rs')]
    inputs += [str(file.relative_to(paired.REPO)) for file in (paired.REPO / 'crates/tea/src').rglob('*.rs')]
    inputs += ['Cargo.toml', 'rust-toolchain.toml', 'crates/tea/Cargo.toml', 'crates/tea/examples/support/scheduled_jobs.rs', 'crates/cloudflare-local/tsconfig.source.json', 'crates/cloudflare-local/wrangler.toml']
    for relative in set(inputs):
        target = artifacts / 'inputs' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(paired.REPO / relative, target)
    result = {'passed': False, 'reference': paired.REFERENCE, 'backend': 'SQLite', 'commands': {h.name: h.command for h in hosts}, 'observations': []}
    try:
        for host in hosts:
            host.start(1)
        for action in ['reset', 'commit', 'rollback', 'sdk-error', 'sdk-reject', 'commit-reject', 'cancel', 'fenced', 'delete', 'inspect']:
            observations = {}
            for host in hosts:
                status, value = host.request('/transactions', {'action': action})
                assert status == 200, (host.name, action, status, value)
                check(action, value)
                observations[host.name] = value
                host.check_runtime()
            if len(hosts) == 2:
                assert observations['source'] == observations['rust'], (action, observations)
            result['observations'].append({'action': action, 'hosts': observations})
            if action == args.stop_after:
                break
        for host in hosts:
            if host.name == 'rust':
                status, profile = host.request('/adapter-profile')
                assert status == 200 and profile and all(value is True for value in profile.values()), profile
                result['rust_adapter_profile'] = profile
            before = host.request('/transactions', {'action': 'inspect'})
            for invalid in [{}, {'action': 'unknown'}, {'action': 'commit', 'extra': 1}, {'action': None}]:
                status, _ = host.request('/transactions', invalid)
                assert status == 400, (host.name, invalid, status)
            assert host.request('/transactions', {'action': 'inspect'}) == before
            host.stop()
            host.start(2)
            assert host.request('/transactions', {'action': 'inspect'}) == before
            # Fast sibling regression: ignored POST body is still consumed.
            assert host.request('/repeat', {})[0] == 200
            assert host.request('/state')[0] == 200
            host.check_runtime()
        result['passed'] = True
    finally:
        for host in hosts:
            host.close()
        result['artifact_sha256'] = {str(file.relative_to(artifacts)): paired.digest(file) for file in artifacts.rglob('*') if file.is_file()}
        paired.write(evidence / 'result.json', result)
    print(json.dumps({'passed': True, 'evidence': str(evidence), 'hosts': [h.name for h in hosts]}))


if __name__ == '__main__':
    main()
