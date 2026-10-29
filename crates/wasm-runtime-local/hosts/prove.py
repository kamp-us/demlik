#!/usr/bin/env python3
"""Drive actual browser and local Workers acceptance for a selected Wasm delivery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
REFERENCE = '75de37ea01a81cd7949e6275b7ee9cfdeb4e312d'


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--delivery', required=True, type=Path)
    parser.add_argument('--source-baseline', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--scratch', required=True, type=Path)
    parser.add_argument('--host', choices=['browser', 'worker', 'all'], default='all')
    parser.add_argument('--chrome', default=os.environ.get('CHROME_BINARY', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    parser.add_argument('--playwright-module', type=Path, default=REPO / 'node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    delivery = evidence / 'delivery'
    shutil.copytree(args.delivery.resolve(), delivery)
    manifest = json.loads((delivery / 'manifest.json').read_text())
    for relative, digest in manifest['sha256'].items():
        assert sha(delivery / relative) == digest, (relative, 'delivery changed')
    baseline = args.source_baseline.resolve()
    frozen = json.loads((baseline / 'freeze.json').read_text())
    assert frozen == {name: sha(REPO / name) for name in frozen}, 'Source changed after Node baseline'
    guard = subprocess.run(['git', 'diff', '--exit-code', REFERENCE, '--', 'packages/tea/src', 'packages/tea/package.json'], cwd=REPO, capture_output=True)
    (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
    (evidence / 'frozen-source.stderr').write_bytes(guard.stderr)
    assert guard.returncode == 0
    result = {'passed': False, 'raw_wasm_sha256': manifest['raw_sha256'], 'source_reference': REFERENCE, 'commands': {}, 'hosts': {}}
    files = [file for file in ROOT.rglob('*') if file.is_file() and 'node_modules' not in file.parts and '__pycache__' not in file.parts]
    files += [ROOT.parent / 'source.mts', ROOT.parent / 'source-fixture.mts', ROOT.parent / 'tsconfig.source.json']
    for file in files:
        destination = evidence / 'inputs' / file.relative_to(REPO)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)
    try:
        if args.host in ['browser', 'all']:
            command = ['node', str(ROOT / 'browser-run.mjs'), str(delivery / 'browser'), str(evidence / 'browser'), str(args.scratch.resolve() / 'chrome-profile'), str(args.playwright_module.resolve()), args.chrome, str(baseline / 'observations.json')]
            run = subprocess.run(command, cwd=REPO, capture_output=True, timeout=90)
            (evidence / 'browser-driver.stdout').write_bytes(run.stdout)
            (evidence / 'browser-driver.stderr').write_bytes(run.stderr)
            result['commands']['browser'] = {'command': command, 'status': run.returncode}
            assert run.returncode == 0, run.stderr.decode()
            browser = json.loads((evidence / 'browser/result.json').read_text())
            assert browser['passed']
            network = json.loads((evidence / 'browser/network.json').read_text())
            wasm = [row for row in network if row['path'] == '/runtime_bg.wasm']
            assert len(wasm) == 2 and all(row['sha256'] == sha(delivery / 'browser/runtime_bg.wasm') for row in wasm)
            cleanup = json.loads((evidence / 'browser/cleanup.json').read_text())
            assert cleanup['server_closed'] and cleanup['cdp_closed'] and cleanup['chrome_stopped']
            result['hosts']['browser'] = {'product': browser['browser']['product'], 'phases': 3, 'source_rust_pairs': 3, 'network_wasm_sha256': wasm[0]['sha256']}
        if args.host in ['worker', 'all']:
            command = ['python3', str(ROOT / 'worker-run.py'), '--delivery', str(delivery / 'worker'), '--source-baseline', str(baseline), '--evidence', str(evidence / 'worker'), '--state-root', str(args.scratch.resolve() / 'worker-state')]
            run = subprocess.run(command, cwd=REPO, capture_output=True, timeout=90)
            (evidence / 'worker-driver.stdout').write_bytes(run.stdout)
            (evidence / 'worker-driver.stderr').write_bytes(run.stderr)
            result['commands']['worker'] = {'command': command, 'status': run.returncode}
            assert run.returncode == 0, run.stderr.decode()
            worker = json.loads((evidence / 'worker/result.json').read_text())
            assert worker['passed'] and all(not row['before_stop'] for row in worker['runtime_checks'])
            assert json.loads((evidence / 'worker/cleanup.json').read_text())['closed']
            for relative in ['index.mjs', 'runtime_bg.wasm']:
                assert sha(evidence / 'worker/artifacts' / relative) == sha(delivery / 'worker' / relative)
            result['hosts']['worker'] = {'phases': 4, 'source_rust_pairs': 4, 'process_activations': 2}
        result['qualifications'] = ['Actual headless system Chrome and local workerd only; no cloud deployment or other browsers claimed',
                                    'Native Chrome diagnostics are retained separately; JS/page errors and Actor observations are the functional acceptance boundary, not graphics/environment acceptance',
                                    'Same delivered raw generic Actor Wasm, newly generated web bindings; no Rust/core/Cargo change or rebuild',
                                    'Fixture Source wrapper is adapted; original Node stdout and all seven objects are reproduced before host comparison',
                                    'Complete logical traces, models, reports and exact Store strings compare; clocks/latency are observed separately',
                                    'Asynchronous in-process string Store only, not disk/SDK storage or crash recovery',
                                    'Minimal supplementary Effect scope only; high-level Agent.run and broad Effect/SDK acceptance remain separate']
        result['passed'] = True
    finally:
        for relative, digest in manifest['sha256'].items():
            assert sha(delivery / relative) == digest, (relative, 'executed delivery changed')
        result['sha256'] = {str(file.relative_to(evidence)): sha(file) for file in evidence.rglob('*') if file.is_file()}
        write(evidence / 'result.json', result)
    print(json.dumps({'passed': True, 'evidence': str(evidence), 'hosts': result['hosts']}))


if __name__ == '__main__':
    main()
