#!/usr/bin/env python3
"""Execute real Source and delivered generic Actor Wasm in local workerd."""
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

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]


def write(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def errors(raw):
    clean = re.sub(r'\x1b\[[0-9;]*m', '', raw)
    return [line for line in clean.splitlines() if any(marker in line for marker in ['[ERROR]', 'Uncaught ', 'Critical Error:', 'runtime crashed unexpectedly', "Can't read from request stream after response has been sent"])]


def clean_timers(value):
    for stats in value.values():
        assert stats['active'] == [] and stats['errors'] == [], stats


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--delivery', required=True, type=Path)
    parser.add_argument('--source-baseline', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--state-root', required=True, type=Path)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    artifacts = evidence / 'artifacts'
    shutil.copytree(args.delivery.resolve(), artifacts)
    expected = json.loads((args.source_baseline / 'observations.json').read_text())
    port = free_port()
    config = evidence / 'wrangler.json'
    write(config, {'name': 'demlik-generic-actor-local-proof', 'main': str(artifacts / 'index.mjs'),
                   'compatibility_date': '2026-10-23', 'find_additional_modules': True,
                   'rules': [{'type': 'CompiledWasm', 'globs': ['**/*.wasm'], 'fallthrough': True}]})
    command = [str(ROOT / 'node_modules/.bin/wrangler'), 'dev', '--config', str(config), '--no-bundle', '--local', '--ip', '127.0.0.1', '--port', str(port), '--inspector-port', '0', '--persist-to', str(args.state_root.resolve()), '--show-interactive-dev-session=false']
    result = {'passed': False, 'profile': 'local workerd', 'command': command, 'observations': [], 'lifecycle': [], 'runtime_checks': []}
    request_file = (evidence / 'requests.jsonl').open('w')
    process = log = log_path = None

    def request(path, body=None):
        payload = None if body is None else json.dumps(body).encode()
        method = 'GET' if payload is None else 'POST'
        req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=payload, method=method, headers={'Content-Type': 'application/json'})
        record = {'sent_ms': time.time_ns() // 1_000_000, 'method': method, 'path': path, 'request_body': None if payload is None else payload.decode()}
        try:
            try:
                response = urllib.request.urlopen(req, timeout=10)
            except urllib.error.HTTPError as error:
                response = error
            raw = response.read().decode()
            record.update(status=response.status, body=raw)
            value = json.loads(raw) if response.status == 200 else raw
            if response.status == 200 and path == '/health':
                assert value['ok'] is True and value['smoke'] == {'count': 1}
                assert record['sent_ms'] - 2 <= value['clock'] <= time.time_ns() // 1_000_000 + 2
            return response.status, value
        except OSError as error:
            record['error'] = str(error)
            raise
        finally:
            record['received_ms'] = time.time_ns() // 1_000_000
            request_file.write(json.dumps(record) + '\n')
            request_file.flush()

    def start(number):
        nonlocal process, log, log_path
        log_path = evidence / f'wrangler-{number}.log'
        log = log_path.open('w')
        env = dict(os.environ, WRANGLER_SEND_METRICS='false', CI='1', WRANGLER_LOG_PATH=str(evidence / 'debug-logs'))
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        result['lifecycle'].append({'event': 'start', 'pid': process.pid, 'at_ms': time.time_ns() // 1_000_000})
        for _ in range(150):
            assert process.poll() is None, f'workerd exited; inspect {log_path}'
            try:
                status, value = request('/health')
                assert status == 200, (status, value)
                assert value['ok'] is True and value['smoke'] == {'count': 1}
                return
            except OSError:
                time.sleep(.2)
        raise RuntimeError('local workerd did not become ready')

    def check():
        assert request('/health')[0] == 200
        time.sleep(.2)
        failures = errors(log_path.read_text())
        assert process.poll() is None and not failures, failures

    def stop():
        nonlocal process, log
        if process is None:
            return
        before = log_path.read_text()
        result['runtime_checks'].append({'log': log_path.name, 'before_stop': errors(before)})
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=8)
        result['lifecycle'].append({'event': 'stop', 'pid': process.pid, 'code': process.returncode, 'at_ms': time.time_ns() // 1_000_000})
        log.close()
        result['runtime_checks'][-1]['during_stop'] = errors(log_path.read_text()[len(before):])
        process = None

    try:
        start(1)
        for phase in ['first', 'repeat', 'second-repeat', 'fresh-process']:
            if phase == 'fresh-process':
                check()
                stop()
                start(2)
            pair = {}
            for kind in ['source', 'rust']:
                status, record = request('/run', {'kind': kind})
                assert status == 200, (kind, status, record)
                pair[kind] = record
                # Retain complete observations before checking a cross-host difference.
                result['observations'].append({'phase': phase, 'kind': kind, **record})
                write(evidence / 'observations.json', result['observations'])
                value = record['value']
                observations = value if kind == 'source' else value['observations']
                assert observations == expected, {'phase': phase, 'kind': kind, 'actual': observations, 'expected': expected}
                if kind == 'rust':
                    clean_timers(value['timers'])
                    for name in ['a', 'b']:
                        assert value['timers'][name]['arms'] == [10000, 4]
                        assert value['timers'][name]['clears'] == [1, 2]
                    assert value['timers']['drain']['arms'] == value['timers']['dispose']['arms'] == [15]
                assert request('/health')[0] == 200
            assert pair['source']['value'] == pair['rust']['value']['observations']
            status, seams = request('/run', {'kind': 'seams'})
            assert status == 200, seams
            clean_timers({name: row['timers'] for name, row in seams['value'].items()})
            assert seams['value']['dropped_stop']['timers']['clears'] == [1]
            assert seams['value']['drain_arm_failure']['original_cause'] is True
            assert seams['value']['dispose_arm_failure']['original_cause'] is True
            assert seams['value']['effect_scope']['count'] == 2 and seams['value']['effect_scope']['closed'] is True
            event = seams['value']['clock_telemetry']['events'][0]
            assert event['seq'] == 1 and event['msgType'] == 'add'
            assert seams['began_ms'] <= event['at'] <= seams['ended_ms']
            result['observations'].append({'phase': phase, 'kind': 'seams', **seams})
            check()
        for invalid in [{}, {'kind': 'unknown'}, {'kind': 'source', 'extra': 1}]:
            assert request('/run', invalid)[0] == 400
        check()
        result['passed'] = True
    finally:
        stop()
        request_file.close()
        with socket.socket() as sock:
            closed = sock.connect_ex(('127.0.0.1', port)) != 0
        write(evidence / 'cleanup.json', {'port': port, 'closed': closed})
        result['sha256'] = {str(file.relative_to(artifacts)): hashlib.sha256(file.read_bytes()).hexdigest() for file in artifacts.rglob('*') if file.is_file()}
        write(evidence / 'result.json', result)
        assert closed, 'owned worker port still open'
    print(json.dumps({'passed': True, 'evidence': str(evidence)}))


if __name__ == '__main__':
    main()
