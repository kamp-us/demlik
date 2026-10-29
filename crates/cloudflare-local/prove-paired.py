#!/usr/bin/env python3
"""Compare frozen Source and Rust through actual isolated local Durable Objects."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request

REFERENCE = '75de37ea01a81cd7949e6275b7ee9cfdeb4e312d'
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
RUNTIME_ERRORS = ("Can't read from request stream after response has been sent",
                  "Uncaught ", "The Workers runtime crashed unexpectedly")


def runtime_errors(text):
    return [line for line in text.splitlines() if any(signal in line for signal in RUNTIME_ERRORS)]


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def write(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class Host:
    def __init__(self, name, artifact, class_name, evidence):
        self.name = name
        self.directory = evidence / name
        self.directory.mkdir()
        self.port = free_port()
        self.process = None
        self.log = None
        self.lifecycle = []
        self.runtime_checks = []
        self.requests = (self.directory / 'requests.jsonl').open('w')
        config = self.directory / 'wrangler.json'
        write(config, {
            'name': f'demlik-paired-{name}', 'main': str(artifact),
            'compatibility_date': '2026-10-28',
            'durable_objects': {'bindings': [{'name': 'JOBS', 'class_name': class_name}]},
            'migrations': [{'tag': 'v1', 'new_sqlite_classes': [class_name]}],
        })
        self.command = [str(ROOT / 'node_modules/.bin/wrangler'), 'dev', '--config', str(config),
                        '--no-bundle', '--local', '--ip', '127.0.0.1', '--port', str(self.port),
                        '--inspector-port', '0', '--persist-to', str(self.directory / 'state'),
                        '--show-interactive-dev-session=false']

    def request(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        method = 'GET' if data is None else 'POST'
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        record = {'sent_at_ms': time.time_ns() // 1_000_000, 'method': method,
                  'path': path, 'request_body': None if data is None else data.decode()}
        try:
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            raw = response.read().decode()
            record.update(status=response.status, body=raw)
            return response.status, json.loads(raw) if response.status == 200 else raw
        except OSError as error:
            record['error'] = str(error)
            raise
        finally:
            record['received_at_ms'] = time.time_ns() // 1_000_000
            self.requests.write(json.dumps(record) + '\n')
            self.requests.flush()

    def start(self, number):
        self.log_path = self.directory / f'wrangler-{number}.log'
        self.log = self.log_path.open('w')
        env = dict(os.environ, WRANGLER_SEND_METRICS='false', CI='1',
                   WRANGLER_LOG_PATH=str(self.directory / 'debug-logs'))
        self.process = subprocess.Popen(self.command, cwd=ROOT, env=env, stdout=self.log,
                                        stderr=subprocess.STDOUT, start_new_session=True)
        self.lifecycle.append({'event': 'start', 'pid': self.process.pid,
                               'at_ms': time.time_ns() // 1_000_000})
        end = time.monotonic() + 30
        while time.monotonic() < end:
            if self.process.poll() is not None:
                raise RuntimeError(f'{self.name} exited; inspect wrangler-{number}.log')
            try:
                status, state = self.request('/state')
                if status == 200:
                    return state
            except OSError:
                pass
            time.sleep(.2)
        raise RuntimeError(f'{self.name} did not become ready')

    def check_runtime(self):
        # The live health request completes before this bounded diagnostic flush.
        time.sleep(.3)
        errors = runtime_errors(self.log_path.read_text())
        assert self.process.poll() is None, f'{self.name} exited before stop'
        assert not errors, (self.name, errors)

    def stop(self):
        if self.process is None:
            return
        pre_stop = self.log_path.read_text()
        self.runtime_checks.append({'log': self.log_path.name,
                                    'pre_stop_errors': runtime_errors(pre_stop)})
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGINT)
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=8)
        self.lifecycle.append({'event': 'stop', 'pid': self.process.pid,
                               'code': self.process.returncode, 'at_ms': time.time_ns() // 1_000_000})
        self.log.close()
        after_stop = self.log_path.read_text()[len(pre_stop):]
        self.runtime_checks[-1]['during_stop_diagnostics'] = runtime_errors(after_stop)
        self.process = None

    def close(self):
        self.stop()
        self.requests.close()
        with socket.socket() as sock:
            closed = sock.connect_ex(('127.0.0.1', self.port)) != 0
        write(self.directory / 'lifecycle.json', self.lifecycle)
        write(self.directory / 'runtime-checks.json', self.runtime_checks)
        write(self.directory / 'cleanup.json', {'port': self.port, 'closed': closed})
        assert closed, f'owned port {self.port} still open'


def events(host, event):
    rows = []
    for line in (host.directory / 'wrangler-2.log').read_text().splitlines():
        match = re.search(r'\{.*\}', line)
        if match:
            try:
                row = json.loads(match[0])
                if row.get('event') == event:
                    rows.append(row)
            except json.JSONDecodeError:
                pass
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--repeat-only', action='store_true', help='Fast actual HTTP unread-body regression, no alarms')
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    artifacts = evidence / 'artifacts'
    artifacts.mkdir()
    guard = subprocess.run(['git', 'diff', '--exit-code', REFERENCE, '--', 'packages/tea/src',
                            'packages/tea/package.json'], cwd=REPO, capture_output=True)
    (evidence / 'frozen-source.diff').write_bytes(guard.stdout)
    (evidence / 'frozen-source.stderr').write_bytes(guard.stderr)
    assert guard.returncode == 0, 'Source must match frozen reference'
    source = artifacts / 'source.js'
    command = [str(ROOT / 'node_modules/.bin/esbuild'), str(ROOT / 'source.ts'), '--bundle',
               '--format=esm', '--platform=browser', f'--outfile={source}',
               f'--metafile={artifacts / "source-meta.json"}']
    build = subprocess.run(command, cwd=REPO, capture_output=True)
    (artifacts / 'source-build.stdout').write_bytes(build.stdout)
    (artifacts / 'source-build.stderr').write_bytes(build.stderr)
    write(artifacts / 'source-producer.json', {'command': command, 'status': build.returncode})
    assert build.returncode == 0
    shutil.copytree(ROOT / 'build', artifacts / 'rust')
    # Retain every Source producer input, not dependency caches or Cargo targets.
    inputs = json.loads((artifacts / 'source-meta.json').read_text())['inputs']
    source_hashes = {}
    for relative in inputs:
        file = REPO / relative
        target = artifacts / 'source-inputs' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        source_hashes[relative] = digest(file)
    for relative in ['crates/cloudflare-local/source.ts', 'crates/cloudflare-local/prove-paired.py',
                     'crates/cloudflare-local/src/lib.rs',
                     'crates/tea/examples/support/scheduled_jobs.rs', 'Cargo.lock',
                     'crates/cloudflare-local/package-lock.json']:
        file = REPO / relative
        target = artifacts / 'producer-inputs' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        source_hashes[relative] = digest(file)
    hashes = {str(file.relative_to(artifacts)): digest(file) for file in artifacts.rglob('*') if file.is_file()}
    hosts = [Host('source', source, 'SourceJobs', evidence),
             Host('rust', artifacts / 'rust/index.js', 'Jobs', evidence)]
    result = {'passed': False, 'reference': REFERENCE, 'artifact_sha256': hashes,
              'source_sha256': source_hashes, 'commands': {h.name: h.command for h in hosts}}
    try:
        initial = {h.name: h.start(1) for h in hosts}
        assert initial['source'] == initial['rust'] == {'model': {'pending': [], 'done': []}, 'alarm': None, 'stored_json': None}
        if args.repeat_only:
            for host in hosts:
                for _ in range(3):
                    status, repeated = host.request('/repeat', {})
                    assert status == 200 and repeated == initial[host.name]
                    status, health = host.request('/state')
                    assert status == 200 and health == initial[host.name]
                    host.check_runtime()
            result.update(passed=True, mode='repeat-only', initial=initial)
            print('PASS: three body-bearing repeat POSTs per host and live health, no pre-stop runtime errors', flush=True)
            return
        future = time.time_ns() // 1_000_000 + 20000
        jobs = [future, future + 20000, future + 40000]
        write(evidence / 'schedule.json', {'jobs': jobs})
        invalid = [{'jobs': jobs[:2]}, {'jobs': [jobs[0], jobs[0], jobs[2]]},
                   {'jobs': [jobs[0] + .5, jobs[1], jobs[2]]}, {'jobs': [-1, 1, 2]},
                   {'jobs': jobs, 'extra': True}, {'jobs': ['1', jobs[1], jobs[2]]}]
        for body in invalid:
            for host in hosts:
                assert host.request('/seed', body)[0] == 400, (host.name, body)
                assert host.request('/state')[1] == initial[host.name], 'invalid input changed storage'
        seeded = {}
        for host in hosts:
            status, seed = host.request('/seed', {'jobs': jobs})
            assert status == 200
            seeded[host.name] = seed
        wire = json.dumps({'pending': jobs, 'done': []}, separators=(',', ':'))
        expected_seed = {'model': {'pending': jobs, 'done': []}, 'alarm': jobs[0], 'stored_json': wire}
        assert seeded['source'] == seeded['rust'] == expected_seed
        for host in hosts:
            host.stop()
        recovered = {h.name: h.start(2) for h in hosts}
        assert recovered == seeded
        assert time.time_ns() // 1_000_000 < jobs[0], 'recovery must precede first deadline'
        print('Both persisted schedules recovered before first deadline', flush=True)
        observed = {h.name: [] for h in hosts}
        end = time.monotonic() + 90
        while time.monotonic() < end:
            for host in hosts:
                status, state = host.request('/state')
                assert status == 200
                count = len(state['model']['done'])
                expected_model = {'pending': jobs[count:], 'done': jobs[:count]}
                assert state['model'] == expected_model, state
                assert state['stored_json'] == json.dumps(expected_model, separators=(',', ':')), state
                assert state['alarm'] == (jobs[count] if count < 3 else None), state
                if count > len(observed[host.name]):
                    assert count == len(observed[host.name]) + 1, 'missed intermediate state'
                    assert time.time_ns() // 1_000_000 >= jobs[count - 1], 'completed before deadline'
                    observed[host.name].append(state)
                    print(f'{host.name}: {count} settled completion(s)', flush=True)
            if all(len(rows) == 3 for rows in observed.values()):
                break
            time.sleep(.25)
        else:
            raise RuntimeError('three actual alarms did not complete')
        assert observed['source'] == observed['rust'], 'exact settled models/cells/alarms differ'
        callbacks = {}
        transitions = {}
        for host in hosts:
            callbacks[host.name] = [x for x in events(host, 'callback') if x['origin'] == 'alarm']
            assert len(callbacks[host.name]) == 3, callbacks
            for index, callback in enumerate(callbacks[host.name]):
                assert callback['at'] >= jobs[index], callback
                assert callback['model'] == {'pending': jobs[index:], 'done': jobs[:index]}, callback
            transitions[host.name] = events(host, 'transition_saved')
            assert [x['model'] for x in transitions[host.name]] == [x['model'] for x in observed[host.name]]
        repeated = {}
        for host in hosts:
            status, repeated[host.name] = host.request('/repeat', {})
            assert status == 200 and repeated[host.name] == observed[host.name][-1]
            status, health = host.request('/state')
            assert status == 200 and health == repeated[host.name]
            host.check_runtime()
            host.stop()
        restarted = {h.name: h.start(3) for h in hosts}
        assert restarted == repeated
        for host in hosts:
            assert host.request('/seed', {'jobs': [jobs[-1] + 120000 + n * 10000 for n in range(3)]})[0] == 409
        for host in hosts:
            host.check_runtime()
            host.stop()
            assert all(not check['pre_stop_errors'] for check in host.runtime_checks), host.runtime_checks
        assert hashes == {str(file.relative_to(artifacts)): digest(file) for file in artifacts.rglob('*') if file.is_file()}, 'executed artifacts changed'
        result.update(passed=True, jobs=jobs, initial=initial, seeded=seeded, recovered=recovered,
                      observed=observed, callbacks=callbacks, transitions=transitions,
                      repeated=repeated, restarted=restarted,
                      qualifications=['Local workerd process restart and real SDK storage/alarms only',
                                      'Callback arrival clocks may differ; only ordering and deadline lower bounds compared',
                                      'POST /repeat exercises timer callback path, not forced platform redelivery',
                                      'Private UTF8-key/string-cell/unfenced snapshot adapter; transactions unsupported',
                                      'No cloud deployment, idle eviction, full Agent.run Wasm or broad cross-cloud proof'])
        print('PASS: exact paired states, cells, deadlines, restart and repeated callback', flush=True)
    except BaseException as error:
        result['error'] = repr(error)
        raise
    finally:
        for host in hosts:
            host.close()
        result['runtime_checks'] = {h.name: h.runtime_checks for h in hosts}
        write(evidence / 'result.json', result)


if __name__ == '__main__':
    main()
