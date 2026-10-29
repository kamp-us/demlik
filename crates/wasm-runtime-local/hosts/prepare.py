#!/usr/bin/env python3
"""Prepare browser/workerd delivery from a selected immutable raw Wasm product."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--raw-wasm', required=True, type=Path)
    parser.add_argument('--raw-sha256', required=True)
    parser.add_argument('--gzip-sha256')
    parser.add_argument('--source-baseline', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    baseline = args.source_baseline.resolve()
    frozen = json.loads((baseline / 'freeze.json').read_text())
    assert frozen == {name: sha(REPO / name) for name in frozen}, 'Source producer changed after Node baseline'
    selected = args.raw_wasm.resolve()
    if selected.suffix == '.gz':
        assert args.gzip_sha256 and sha(selected) == args.gzip_sha256
        raw = gzip.decompress(selected.read_bytes())
    else:
        raw = selected.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == args.raw_sha256
    input_file = output / 'inputs' / args.raw_sha256 / 'delivered.wasm'
    input_file.parent.mkdir(parents=True)
    input_file.write_bytes(raw)
    bindgen = Path(os.environ['WASM_BINDGEN'])
    version = subprocess.run([str(bindgen), '--version'], capture_output=True)
    assert version.returncode == 0 and version.stdout.strip() == b'wasm-bindgen 0.2.129'
    browser = output / 'browser'
    browser.mkdir()
    commands = [
        [str(bindgen), str(input_file), '--target', 'web', '--out-dir', str(browser), '--out-name', 'runtime'],
        [str(REPO / 'node_modules/.bin/esbuild'), str(ROOT.parent / 'source-fixture.mts'), '--bundle', '--platform=browser', '--format=esm', f'--outfile={browser / "source-fixture.mjs"}', f'--metafile={output / "source-browser-meta.json"}'],
    ]
    for number, command in enumerate(commands):
        run = subprocess.run(command, cwd=REPO, capture_output=True)
        (output / f'producer-{number}.stdout').write_bytes(run.stdout)
        (output / f'producer-{number}.stderr').write_bytes(run.stderr)
        assert run.returncode == 0, run.stderr
    shutil.copy2(ROOT / 'browser.mjs', browser / 'browser.mjs')
    (browser / 'index.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><title>Generic Actor host proof</title><link rel="icon" href="data:,"><body>Local generic Actor acceptance fixture<script type="module" src="./browser.mjs"></script></body></html>\n')
    worker = output / 'worker'
    worker.mkdir()
    for name in ['runtime.js', 'runtime_bg.wasm', 'source-fixture.mjs']:
        shutil.copy2(browser / name, worker / name)
    shutil.copy2(ROOT / 'worker.mjs', worker / 'worker.mjs')
    command = [str(REPO / 'node_modules/.bin/esbuild'), str(worker / 'worker.mjs'), '--bundle', '--platform=browser', '--format=esm', '--external:./runtime_bg.wasm', f'--outfile={worker / "index.mjs"}', f'--metafile={output / "worker-meta.json"}']
    run = subprocess.run(command, cwd=REPO, capture_output=True)
    (output / 'worker-build.stdout').write_bytes(run.stdout)
    (output / 'worker-build.stderr').write_bytes(run.stderr)
    assert run.returncode == 0, run.stderr
    commands.append(command)
    manifest = {'selected': str(selected), 'selected_sha256': sha(selected), 'raw_sha256': args.raw_sha256,
                'source_baseline': str(baseline), 'source_hashes': frozen, 'commands': commands,
                'wasm_bindgen': {'path': str(bindgen), 'sha256': sha(bindgen), 'version': version.stdout.decode().strip()},
                'qualification': 'Selected raw Wasm is a delivered product, not a copied Cargo dependency cache. Web bindings are newly generated and have distinct hashes.'}
    manifest['sha256'] = {str(file.relative_to(output)): sha(file) for file in output.rglob('*') if file.is_file()}
    write(output / 'manifest.json', manifest)
    print(json.dumps({'prepared': str(output), 'raw_sha256': args.raw_sha256, 'web_wasm_sha256': sha(browser / 'runtime_bg.wasm')}))


if __name__ == '__main__':
    main()
