#!/usr/bin/env python3
"""Capture actual Source CLI observations before native projection in this suite."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
import sys

PROOF = Path(sys.argv[1]).resolve()
PROOF.mkdir(parents=True, exist_ok=True)
HERE = Path(__file__).resolve().parent
MAIN = HERE.parents[1]
NODE = Path('/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node')
TSX = Path(subprocess.check_output(
    [str(NODE), '-p', "require('node:module').createRequire(process.argv[1]).resolve('tsx')",
     str(HERE / 'package.json')], cwd=MAIN, text=True).strip())
CASES = json.loads((HERE / 'cli-hotspots-window-cases.json').read_text())
assert len(CASES['cases']) == 20
assert len({row['id'] for row in CASES['cases']}) == 20
assert not (PROOF / 'source-first.json').exists(), 'Source freeze already exists'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save(name, value):
    (PROOF / name).write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')

def run_git(root, args, **extra):
    env = dict(os.environ, PATH=str(NODE.parent) + ':/usr/bin:/bin', TZ='UTC',
               GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0', **extra)
    command = ['/usr/bin/git', '-C', str(root), *args]
    result = subprocess.run(command, env=env, capture_output=True, timeout=30)
    setup.append({'argv': command, 'environment': {k: env[k] for k in extra},
                  'status': result.returncode, 'stdout': result.stdout.decode('utf8', 'replace'),
                  'stderr': result.stderr.decode('utf8', 'replace')})
    assert result.returncode == 0, setup[-1]
    return result.stdout.decode().strip()

def files(root, git=False):
    result = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if not git and '.git' in path.relative_to(root).parts:
            continue
        if git and '.git' not in path.relative_to(root).parts:
            continue
        info = path.lstat()
        if path.is_file():
            data = path.read_bytes()
            result[relative] = {'kind': 'file', 'mode': stat.S_IMODE(info.st_mode),
                                'bytes': len(data), 'sha256': digest(data),
                                **({} if git else {'base64': base64.b64encode(data).decode()})}
        elif path.is_symlink():
            result[relative] = {'kind': 'symlink', 'mode': stat.S_IMODE(info.st_mode),
                                'target': os.readlink(path)}
    return result

def delta(before, after):
    return {key: {'before': before.get(key), 'after': after.get(key)}
            for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)}

def seed(root):
    root.mkdir()
    initial = {
        'README.md': 'Owned actual Source hotspots window fixture.\n',
        'package.json': '{"name":"window-workflow","private":true}\n',
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
        'packages/alpha/package.json': '{"name":"alpha","private":true}\n',
        'packages/alpha/a.ts': 'export function alpha(n: number) { return n + 1; }\n',
        'packages/alpha/b.ts': 'import { alpha } from "./a.js";\nexport function beta(n: number) { if (n > 0) return alpha(n); return 0; }\n',
        'packages/alpha/c.ts': 'export function gamma() { return 3; }\n',
        'packages/second/package.json': '{"name":"second","private":true}\n',
        'packages/second/A.ts': 'export function extra(n: number) { if (n > 0 && n < 10) return n; return 0; }\n',
        'packages/second/z.ts': 'export function zeta() { return 4; }\n',
        'packages/second/é.ts': 'export function accent(n: number) { return n; }\n',
    }
    for name, text in initial.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(0o644)

def source_step(case, step, location):
    fixture = fixtures[step.get('fixture', 'git')]
    if 'seedOutput' in step:
        path = fixture / step['out']
        path.write_text(step['seedOutput'])
        path.chmod(step.get('seedMode', 0o644))
    if 'chmodBefore' in step:
        (fixture / step['out']).chmod(step['chmodBefore'])
    target = str(fixture / step.get('target', '.'))
    argv = [target, '--hotspots']
    if step.get('json', True):
        argv.append('--json')
    argv.extend(step.get('flags', []))
    if 'since' in step:
        argv.extend(['--hotspots-since', step['since']])
    if 'out' in step:
        argv.extend(['--out', str(fixture / step['out'])])
    stem = f"{case['id']}--{step['id']}"
    request_path = location / (stem + '.request.json')
    trace = location / (stem + '.trace.jsonl')
    io_trace = location / (stem + '.io.jsonl')
    clock_trace = location / (stem + '.clock.json')
    trace.write_text('')
    io_trace.write_text('')
    request = {'fixture': str(fixture), 'trace': str(trace), 'ioTrace': str(io_trace),
               'clockTrace': str(clock_trace), 'clockMs': step.get('clockMs', CASES['clockMs']),
               'input': {'action': 'frontdoor', 'argv': argv}}
    if 'initial' in step:
        request['input']['initial'] = step['initial']
    request_path.write_text(json.dumps(request, ensure_ascii=True) + '\n')
    env = dict(os.environ, PATH=step.get('PATH', str(NODE.parent) + ':/usr/bin:/bin'),
               TZ='UTC', TMPDIR='/private/tmp', TSX_DISABLE_CACHE='1', FORCE_COLOR='0', NO_COLOR='1',
               DEMLIK_FRONTDOOR_REQUEST=str(request_path))
    if step.get('withoutGit'):
        env['PATH'] = str(temporary / 'empty-bin')
    if step.get('TZ', 'UTC') is None:
        env.pop('TZ', None)
    else:
        env['TZ'] = step.get('TZ', 'UTC')
    command = [str(NODE), '--import', str(HERE / 'cli-hotspots-window-clock.mjs'), '--import', str(TSX),
               str(MAIN / 'verification/parity/cli-plain-collapse-source.mts'), *argv]
    before = files(fixture)
    git_before = files(fixture, git=True)
    started = time.monotonic()
    with readonly.open('rb') as descriptor:
        process = subprocess.run(command, cwd=fixture, env=env, stdin=subprocess.DEVNULL,
                                 stdout=descriptor if step.get('badStdout') else subprocess.PIPE,
                                 stderr=descriptor if step.get('badStderr') else subprocess.PIPE,
                                 timeout=60)
    after = files(fixture)
    stdout, stderr = process.stdout or b'', process.stderr or b''
    for suffix, body in [('stdout', stdout), ('stderr', stderr)]:
        (location / (stem + '.' + suffix)).write_bytes(body)
    def lines(path):
        return [json.loads(line) for line in path.read_text().splitlines() if line]
    result = {'id': step['id'], 'requestFile': str(request_path),
              'requestSha256': digest(request_path.read_bytes()), 'argv': argv,
              'command': command, 'cwd': str(fixture),
              'environment': {key: env.get(key) for key in ['PATH', 'TZ', 'TMPDIR', 'FORCE_COLOR', 'NO_COLOR']},
              'process': {'status': process.returncode if process.returncode >= 0 else None,
                          'signal': -process.returncode if process.returncode < 0 else None,
                          'stdout': stdout.decode('utf8', 'replace'), 'stderr': stderr.decode('utf8', 'replace'),
                          'stdoutSha256': digest(stdout), 'stderrSha256': digest(stderr),
                          'stdoutBytes': len(stdout), 'stderrBytes': len(stderr)},
              'elapsedSeconds': time.monotonic() - started,
              'events': lines(trace), 'io': lines(io_trace),
              'clock': json.loads(clock_trace.read_text()) if clock_trace.exists() else None,
              'before': before, 'after': after, 'delta': delta(before, after),
              'gitBefore': git_before, 'gitAfter': files(fixture, git=True)}
    payload = after[step['out']]['base64'] if 'out' in step and step['out'] in after else None
    payload_text = base64.b64decode(payload).decode() if payload is not None else result['process']['stdout']
    if payload_text.strip().startswith('{'):
        try:
            parsed = json.loads(payload_text)
            if 'window' in parsed:
                result['observedWindow'] = parsed['window']
                result['observedRows'] = len(parsed['rows'])
                result['noHistoryCount'] = parsed['noHistoryCount']
        except json.JSONDecodeError:
            pass
    assert result['clock'] is not None, 'observer did not reach process exit'
    assert result['clock']['node'] == 'v22.21.1'
    assert result['clock']['versions'] == {'v8': '12.4.254.21-node.33', 'icu': '77.1', 'tz': '2025b'}
    return result

setup, rows, error = [], [], None
temporary = Path(sys.argv[2]).resolve()
assert temporary.is_dir() and not any(temporary.iterdir()), 'wrapper owns empty fixture parent'
fixtures = {key: temporary / key for key in ['git', 'not-repo', 'unborn']}
readonly = temporary / 'readonly.txt'
readonly.write_text('read-only descriptor for actual failed stream writes\n')
(temporary / 'empty-bin').mkdir()
source_files = ['packages/code-graph/src/index.ts', 'packages/code-graph/src/cli.ts',
                'packages/code-graph/src/hotspots/churn.ts', 'packages/code-graph/src/hotspots/render.ts',
                'packages/code-graph/src/extract/project.ts', 'packages/code-graph/src/extract/assemble.ts',
                'packages/code-graph/src/render/json.ts', 'packages/code-graph/src/config.ts',
                'verification/parity/cli-plain-collapse-source.mts',
                'verification/parity/cli-collapse-source.mts', 'verification/parity/cli-layer-source.mts',
                'verification/parity/cli-frontdoor-source.mts']
source_before = {name: digest((MAIN / name).read_bytes()) for name in source_files}
head = subprocess.check_output(['/usr/bin/git', '-C', str(MAIN), 'rev-parse', 'HEAD'], text=True).strip()
save('source-input-freeze.json', {'head': head, 'beforeNativeProjection': True, 'beforeRustEdits': False,
      'casesSha256': digest((HERE / 'cli-hotspots-window-cases.json').read_bytes()),
      'clockObserverSha256': digest((HERE / 'cli-hotspots-window-clock.mjs').read_bytes()),
      'runnerSha256': digest(Path(__file__).read_bytes()), 'sourcePins': source_before,
      'wholeviews': 20, 'nativeRuns': 0, 'cargoRuns': 0})
try:
    for root in fixtures.values():
        seed(root)
    for key in ['git', 'unborn']:
        run_git(fixtures[key], ['init', '--quiet', '--initial-branch=main'])
    root = fixtures['git']
    run_git(root, ['add', '.'])
    run_git(root, ['commit', '--quiet', '-m', 'Initial owned window fixture'],
            GIT_AUTHOR_DATE='2026-10-01T12:00:00Z', GIT_COMMITTER_DATE='2026-10-01T12:00:00Z')
    (root / 'packages/alpha/b.ts').write_text('import { alpha } from "./a.js";\nexport function beta(n: number) { if (n > 1) return alpha(n); return 0; }\n')
    run_git(root, ['add', 'packages/alpha/b.ts'])
    run_git(root, ['commit', '--quiet', '-m', 'Change beta'],
            GIT_AUTHOR_DATE='2026-10-20T12:00:00Z', GIT_COMMITTER_DATE='2026-10-20T12:00:00Z')
    (root / 'packages/second/new.ts').write_text('export function untracked() { return 9; }\n')
    (PROOF / 'processes').mkdir()
    save('fixture-before.json', {key: files(root) for key, root in fixtures.items()})
    for case in CASES['cases']:
        view = {'id': case['id'], 'steps': []}
        for step in case['steps']:
            view['steps'].append(source_step(case, step, PROOF / 'processes'))
        rows.append(view)
        save('source-progress.json', {'completedWholeviews': len(rows), 'ids': [row['id'] for row in rows]})
        print(json.dumps({'id': case['id'], 'steps': len(view['steps']),
                          'statuses': [s['process']['status'] for s in view['steps']]}), flush=True)
except BaseException as failure:
    error = {'type': type(failure).__name__, 'message': str(failure)}
    raise
finally:
    source_after = {name: digest((MAIN / name).read_bytes()) for name in source_files}
    final_files = {key: files(root) for key, root in fixtures.items() if root.exists()}

    for child in temporary.iterdir():
        if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
        else: child.unlink()
    save('source-first.json', {'schema': 1, 'profile': CASES['profile'], 'head': head,
         'frozenSourceCommit': '75de37ea', 'cases': rows, 'setup': setup, 'error': error,
         'sourceBefore': source_before, 'sourceAfter': source_after,
         'sourceUnchanged': source_before == source_after, 'finalFixtureFiles': final_files,
         'cleanup': {'root': str(temporary), 'fixturesRemoved': not any(temporary.iterdir()), 'parentRetainedForWrapper': True},
         'nativeExecutions': 0, 'cargoExecutions': 0, 'newSharedCredit': 0})
    assert source_before == source_after, 'Main source changed during Source freeze'

print(json.dumps({'cases':len(rows),'steps':sum(len(r['steps'])for r in rows),'error':error,'phase':'source-complete'}),flush=True)
