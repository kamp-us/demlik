"""Compile each host/coordinator fault and require the real process witness to fail."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    root = Path(__file__).resolve().parents[2]
    binary = root / 'crates/code-graph/src/bin/code-graph.rs'
    coordinator = root / 'crates/code-graph/src/cli/frontdoor.rs'
    originals = {file: file.read_text() for file in [binary, coordinator]}
    selection = 'TerminalFacts::snapshot(stdout.is_terminal()).tree_style()'
    faults = [
        ('always-plain', binary, selection, 'TreeStyle::Plain', 'pipe-force-1'),
        ('always-ansi', binary, selection, 'TreeStyle::Ansi', 'pipe-plain'),
        ('stderr-tty', binary, 'TerminalFacts::snapshot(stdout.is_terminal())', 'TerminalFacts::snapshot(stderr.is_terminal())', 'pty-auto'),
        ('dropped-tail-style', coordinator, 'dispatch_reports_with_style_blocking(host, compiler, style)', 'dispatch_reports_with_style_blocking(host, compiler, crate::render::tree::TreeStyle::Plain)', 'pipe-force-1'),
    ]
    rows = []
    try:
        for name, owner, before, after, witness in faults:
            assert originals[owner].count(before) == 1, (name, before)
            owner.write_text(originals[owner].replace(before, after))
            build = subprocess.run(['node', 'verification/parity/cli-terminal-tree-build.mjs', str(evidence), name], cwd=root, capture_output=True)
            (evidence / f'{name}.build.stdout').write_bytes(build.stdout)
            (evidence / f'{name}.build.stderr').write_bytes(build.stderr)
            assert build.returncode == 0, (name, build.stderr)
            artifacts = json.loads((evidence / f'{name}.artifacts.json').read_text())
            executed = artifacts['artifacts'][0]['retained']
            run = subprocess.run([sys.executable, 'verification/parity/cli-terminal-tree-process.py', 'native', '--label', name, str(evidence), executed], cwd=root, capture_output=True)
            (evidence / f'{name}.stdout').write_bytes(run.stdout)
            (evidence / f'{name}.stderr').write_bytes(run.stderr)
            assert run.returncode != 0 and f"('{witness}', b'".encode() in run.stderr, (name, run.returncode, run.stderr)
            rows.append({'id': name, 'owner': str(owner.relative_to(root)), 'witness': witness,
                         'detected': True, 'binarySha256': artifacts['artifacts'][0]['sha256']})
            owner.write_text(originals[owner])
            (evidence / 'controls.json').write_text(json.dumps({'complete': False, 'controls': rows}, indent=2) + '\n')
    finally:
        for owner, source in originals.items():
            owner.write_text(source)
    (evidence / 'controls.json').write_text(json.dumps({'complete': True, 'controls': rows}, indent=2) + '\n')
    print(f'{len(rows)} real-process fault controls detected')


if __name__ == '__main__':
    main()
