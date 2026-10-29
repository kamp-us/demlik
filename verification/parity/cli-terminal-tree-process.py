"""Capture complete CLI processes with raw pipe/PTY bytes and separate stderr."""
import argparse
import base64
import errno
import hashlib
import json
import os
from pathlib import Path
import pty
import subprocess
import termios
import threading


def sha(data):
    return hashlib.sha256(data).hexdigest()


def capture(command, argv, env, tty_stdout, cwd):
    chunks = []
    if tty_stdout:
        master, slave = pty.openpty()
        settings = termios.tcgetattr(slave)
        settings[1] &= ~termios.OPOST
        termios.tcsetattr(slave, termios.TCSANOW, settings)
        assert os.isatty(slave)

        def drain():
            while True:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not chunk:
                    return
                chunks.append(chunk)

        reader = threading.Thread(target=drain)
        reader.start()
        process = subprocess.Popen(command + argv, env=env, cwd=cwd,
                                   stdin=subprocess.DEVNULL, stdout=slave, stderr=subprocess.PIPE)
        os.close(slave)
        _, stderr = process.communicate(timeout=90)
        reader.join(timeout=10)
        assert not reader.is_alive()
        os.close(master)
        stdout = b''.join(chunks)
    else:
        process = subprocess.run(command + argv, env=env, cwd=cwd,
                                 stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
        stdout, stderr = process.stdout, process.stderr
    return process.returncode, stdout, stderr


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['source', 'native'])
    parser.add_argument('--label')
    parser.add_argument('evidence', type=Path)
    parser.add_argument('command', nargs='+')
    options = parser.parse_args()
    evidence = options.evidence.resolve()
    label = options.label or options.mode
    (evidence / f'{label}-invocation.json').write_text(json.dumps({'command': options.command, 'commandHashes': {item: sha(Path(item).read_bytes()) for item in options.command if Path(item).is_file()}}, indent=2) + '\n')
    fixture = evidence / 'fixture'
    fixture.mkdir(parents=True, exist_ok=True)
    for name, text in {
        'clean.ts': 'export function greet(name: string) { return name; }\nexport function twice(n: number) { return n * 2; }\n',
        'café.ts': 'export function branch(n: number) {\n  if (n > 2) return 1;\n  if (n > 1) return 2;\n  return 3;\n}\n',
        'clean.test.ts': 'export function testGreet() { return true; }\n',
        'thresholds.json': '{"highComplexity":1,"longFunctionLoc":2}\n',
    }.items():
        (fixture / name).write_text(text)
    base = {'PATH': '/Users/cansirin/.volta/tools/image/node/22.21.1/bin:/opt/homebrew/bin:/usr/bin:/bin',
            'HOME': os.environ['HOME'], 'LANG': 'en_US.UTF-8', 'TZ': 'UTC', 'TMPDIR': '/private/tmp',
            'TERM': 'xterm-256color', 'COLUMNS': '80',
            'DEMLIK_CODE_GRAPH_COMPILER_MANIFEST': '/Users/cansirin/Documents/development/demlik/packages/code-graph/node_modules/@typescript/native-preview/package.json'}
    profiles = [
        ('pipe-plain', False, {}, []),
        *[(f'pipe-force-{value}', False, {'FORCE_COLOR': value}, []) for value in ['0', '1', '3', 'false']],
        ('pipe-dumb', False, {'TERM': 'dumb'}, []),
        ('pipe-force-dumb', False, {'TERM': 'dumb', 'FORCE_COLOR': '1'}, []),
        ('pipe-no-color-force', False, {'NO_COLOR': '1', 'FORCE_COLOR': '1'}, []),
        ('pty-auto', True, {}, []),
        ('pty-dumb', True, {'TERM': 'dumb'}, []),
        ('pty-force-zero', True, {'FORCE_COLOR': '0'}, []),
        ('pipe-json-force', False, {'FORCE_COLOR': '1'}, ['--json']),
        ('pty-json', True, {}, ['--json']),
        ('pipe-out-force', False, {'FORCE_COLOR': '1'}, ['--out', str(evidence / 'output.txt')]),
        ('pty-out', True, {}, ['--out', str(evidence / 'output.txt')]),
        ('repeat-plain', False, {}, []),
        ('repeat-ansi', False, {'FORCE_COLOR': '1'}, []),
        ('repeat-plain-again', False, {}, []),
    ]
    rows = []
    for name, tty_stdout, extra, flags in profiles:
        env = base | extra
        argv = [str(fixture), '--tree', '--thresholds', str(fixture / 'thresholds.json'), *flags]
        output = evidence / 'output.txt'
        output.unlink(missing_ok=True)
        code, stdout, stderr = capture(options.command, argv, env, tty_stdout, fixture)
        files = {'output.txt': base64.b64encode(output.read_bytes()).decode()} if output.exists() else {}
        folder = evidence / label / name
        folder.mkdir(parents=True, exist_ok=True)
        for stream, data in [('stdout', stdout), ('stderr', stderr)]:
            (folder / stream).write_bytes(data)
        row = {'id': name, 'argv': argv, 'environment': env, 'stdoutIsTTY': tty_stdout,
               'stderrIsTTY': False, 'ptyOutputProcessing': False, 'exit': code,
               'stdout': base64.b64encode(stdout).decode(), 'stderr': base64.b64encode(stderr).decode(),
               'stdoutSha256': sha(stdout), 'stderrSha256': sha(stderr), 'files': files}
        assert code == 0, (name, stderr)
        if '--json' in flags:
            json.loads(stdout)
            assert b'\x1b' not in stdout
        else:
            rendered = output.read_bytes() if files else stdout
            expected = name in {'pipe-force-1', 'pipe-force-3', 'pipe-force-dumb', 'pipe-no-color-force',
                                'pty-auto', 'pipe-out-force', 'pty-out', 'repeat-ansi'}
            assert (b'\x1b[' in rendered) == expected, (name, rendered)
            if expected:
                for style in [b'\x1b[36m', b'\x1b[1m', b'\x1b[2m', b'\x1b[33m']:
                    assert style in rendered, (name, style, rendered)
        if options.mode == 'native':
            source = json.loads((evidence / 'source-processes.json').read_text())
            expected_row = next(item for item in source if item['id'] == name)
            assert row == expected_row, (name, row, expected_row)
        rows.append(row)
    (evidence / f'{label}-processes.json').write_text(json.dumps(rows, indent=2) + '\n')
    print(f'{options.mode}: {len(rows)} complete process views passed')


if __name__ == '__main__':
    main()
