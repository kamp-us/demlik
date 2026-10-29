"""Freeze a Source workflow or exercise a copied native installation without a builder."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2) + '\n')


def fixture(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'src').mkdir(exist_ok=True)
    write(root / 'package.json', {'name': 'portable-invoice', 'private': True, 'type': 'module'})
    write(root / 'tsconfig.json', {'compilerOptions': {'target': 'ES2022', 'module': 'NodeNext',
          'moduleResolution': 'NodeNext', 'strict': True, 'noEmit': True}, 'include': ['src/**/*.ts']})
    (root / 'src/invoice.ts').write_text('export function readInvoice(value: number) {\n  let total = value;\n' +
        ''.join(f'  if (value > {n}) total += {n + 1};\n' for n in range(20)) + '  return total;\n}\n')
    (root / 'src/index.ts').write_text('import {readInvoice} from "./invoice.js";\nexport function invoice(value: number) { return readInvoice(value); }\n')
    (root / 'src/check.ts').write_text('import {invoice} from "./index.js";\nexport function check(value: number) { return invoice(value); }\n')
    # An independent project root keeps the outer ignored evidence directory out of discovery.
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    poison = root / 'node_modules/@typescript/native-preview'
    poison.mkdir(parents=True, exist_ok=True)
    write(poison / 'package.json', {'name': '@typescript/native-preview', 'version': '0.0.0',
                                   'bin': {'tsgo': './lib/tsgo'}})


def execute(command, args, cwd, destination, name, override=None):
    env = dict(os.environ)
    env.pop('DEMLIK_CODE_GRAPH_COMPILER_MANIFEST', None)
    for key in ['FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'NO_COLOR']:
        env.pop(key, None)
    env['TERM'] = 'dumb'
    if override is not None:
        env['DEMLIK_CODE_GRAPH_COMPILER_MANIFEST'] = str(override)
    destination.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(command + args, cwd=cwd, env=env, capture_output=True, timeout=120)
    (destination / f'{name}.stdout').write_bytes(result.stdout)
    (destination / f'{name}.stderr').write_bytes(result.stderr)
    write(destination / f'{name}.process.json', {'command': command + args, 'cwd': str(cwd),
          'override': None if override is None else str(override), 'exit': result.returncode})
    assert result.returncode >= 0, f'{name}: signal {-result.returncode}'
    return {'exit': result.returncode, 'stdout': result.stdout.decode(), 'stderr': result.stderr.decode()}


def workflow(command, client, destination, override=None):
    fixture(client)
    graph = execute(command, ['.', '--edges', '--graph', '--json'], client, destination, 'edges', override)
    assert graph['exit'] == 0 and graph['stderr'] == '', graph
    parsed = json.loads(graph['stdout'])
    assert parsed, 'real Go graph must contain nodes'
    plan = execute(command, ['.', '--plan', '--by', 'complexity', '--json', '--out', 'plan.json'],
                   client, destination, 'plan', override)
    assert plan['exit'] == 0 and plan['stdout'] == '' and 'wrote' in plan['stderr'], plan
    plan['file'] = (client / 'plan.json').read_text()
    assert json.loads(plan['file']), 'plan must contain refactor targets'
    (destination / 'plan.json').write_text(plan['file'])
    red = execute(command, ['.', '--ci', '--fail-on', 'warn'], client, destination, 'ci-red', override)
    assert red['exit'] == 1 and red['stderr'] == '', red
    (client / 'src/invoice.ts').write_text('export function readInvoice(value: number) { return value; }\n')
    green = execute(command, ['.', '--ci', '--fail-on', 'warn'], client, destination, 'ci-green', override)
    assert green['exit'] == 0 and green['stderr'] == '', green
    return {'edges': graph, 'plan': plan, 'ci-red': red, 'ci-green': green}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['source', 'baseline', 'native', 'postcleanup'])
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--compiler-manifest', required=True, type=Path)
    parser.add_argument('--binary', type=Path)
    parser.add_argument('--node')
    parser.add_argument('--source-entry', type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    client = evidence / 'client-one'
    manifest = args.compiler_manifest.resolve()
    expected_file = evidence / 'source/workflow.json'
    if args.phase == 'source':
        command = [args.node, str(args.source_entry.resolve())]
        value = workflow(command, client, evidence / 'source')
        write(expected_file, value)
        print('Source valid workflow frozen')
        return
    if args.phase == 'baseline':
        payload = evidence / 'baseline-install'
        payload.mkdir()
        shutil.copy2(args.binary, payload / 'code-graph')
        (payload / 'node_modules/@typescript').mkdir(parents=True)
        installed = payload / 'node_modules/@typescript/native-preview'
        installed.mkdir()
        write(installed / 'package.json', {'name': '@typescript/native-preview', 'version': '0.0.0',
                                         'bin': {'tsgo': 'lib/tsgo'}})
        fixture(client)
        result = execute([str(payload / 'code-graph')], ['.', '--edges', '--graph', '--json'], client,
                         evidence / 'baseline', 'installed')
        write(evidence / 'baseline/result.json', {'actual': result, 'requiredExit': 1,
                                                'badInstallationWasIgnored': result['exit'] == 0})
        assert result['exit'] == 0 and json.loads(result['stdout']), 'baseline must expose the ignored installation'
        print('Baseline control: invalid installed compiler was ignored in favor of builder compiler')
        return
    expected = json.loads(expected_file.read_text())
    if args.phase == 'native':
        payload = evidence / 'payload'
        payload.mkdir()
        shutil.copy2(args.binary, payload / 'code-graph')
        (payload / 'node_modules/@typescript').mkdir(parents=True)
        (payload / 'node_modules/@typescript/native-preview').symlink_to(manifest.parent, target_is_directory=True)
        first = workflow([str(payload / 'code-graph')], client, evidence / 'native-installed')
        assert first == expected, 'installed process changed the full Source workflow'
        override = workflow([str(payload / 'code-graph')], client, evidence / 'native-override', manifest)
        assert override == expected, 'explicit manifest compatibility changed'
        # A discovered bad package and an explicit bad override must both fail closed.
        bad = evidence / 'wrong-install/node_modules/@typescript/native-preview'
        bad.mkdir(parents=True)
        write(bad / 'package.json', {'name': '@typescript/native-preview', 'version': '0.0.0', 'bin': {'tsgo': 'lib/tsgo'}})
        bad_payload = evidence / 'wrong-install/code-graph'
        shutil.copy2(args.binary, bad_payload)
        for label, executable, supplied in [
            ('wrong-installed', bad_payload, None),
            ('wrong-override', payload / 'code-graph', bad / 'package.json'),
            ('missing-override', payload / 'code-graph', evidence / 'missing/package.json'),
        ]:
            result = execute([str(executable)], ['.', '--edges', '--graph', '--json'], client,
                             evidence / 'native-errors', label, supplied)
            assert result['exit'] == 1 and result['stdout'] == '', result
            assert ('version mismatch' if label.startswith('wrong') else 'native compiler I/O') in result['stderr'], result
        overridden = workflow([str(bad_payload)], client, evidence / 'native-override-precedence', manifest)
        assert overridden == expected, 'valid explicit override must take precedence over invalid installation'
        empty = evidence / 'empty-install'
        empty.mkdir()
        shutil.copy2(args.binary, empty / 'code-graph')
        missing = execute([str(empty / 'code-graph')], ['.', '--edges', '--graph', '--json'], client,
                          evidence / 'native-errors', 'missing-installed')
        assert missing['exit'] == 1 and missing['stdout'] == '' and 'cannot locate' in missing['stderr'], missing
        relocated = evidence / 'relocated/payload'
        relocated.parent.mkdir()
        payload.rename(relocated)
        second = workflow([str(relocated / 'code-graph')], client, evidence / 'native-relocated')
        assert second == expected
        other = workflow([str(relocated / 'code-graph')], evidence / 'client-two', evidence / 'native-other-client')
        assert other['ci-red'] == expected['ci-red'] and other['ci-green'] == expected['ci-green']
        write(evidence / 'native-result.json', {'passed': True, 'sourceWorkflowsCompared': 4,
              'nativeDiscoveryFailures': 4, 'secondClientCompleted': True,
              'binarySha256': digest(relocated / 'code-graph'), 'globalParityCreditAdded': 0})
        print('Native installed/override/relocated workflows and fail-closed discovery pass')
        return
    executable = evidence / 'relocated/payload/code-graph'
    actual = workflow([str(executable)], client, evidence / 'postcleanup')
    assert actual == expected
    write(evidence / 'postcleanup/result.json', {'passed': True, 'binarySha256': digest(executable),
                                              'globalParityCreditAdded': 0})
    print('Post-cleanup workflow passes without builder')


if __name__ == '__main__':
    main()
