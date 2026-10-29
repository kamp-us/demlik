#!/usr/bin/env python3
"""Run the real local SDK restart/alarm acceptance case. Never deploys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
evidence = args.evidence.resolve()
evidence.mkdir(parents=True, exist_ok=True)
state_dir = evidence / 'local-proof-state'
if state_dir.exists():
    raise SystemExit('Use a fresh evidence directory; persisted state already exists')
config = {
    'name': 'demlik-rust-local-alarm',
    'main': str(root / 'build/index.js'),
    'compatibility_date': '2026-10-28',
    'durable_objects': {'bindings': [{'name': 'JOBS', 'class_name': 'Jobs'}]},
    'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['Jobs']}],
}
config_file = evidence / 'wrangler.proof.json'
config_file.write_text(json.dumps(config, indent=2) + '\n')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
command = [str(root / 'node_modules/.bin/wrangler'), 'dev', '--config', str(config_file),
           '--local', '--ip', '127.0.0.1', '--port', str(port), '--inspector-port', '0',
           '--persist-to', str(state_dir), '--show-interactive-dev-session=false']
env = dict(os.environ, WRANGLER_SEND_METRICS='false',
           WRANGLER_LOG_PATH=str(evidence / 'debug-logs'), CI='1')
process = None
log = None
requests = (evidence / 'requests.jsonl').open('w')
lifecycle = []
observed = []
wasm = root / 'build/index_bg.wasm'
wasm_hash = hashlib.sha256(wasm.read_bytes()).hexdigest()

def request(path, method='GET'):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method)
    try:
        response = urllib.request.urlopen(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read().decode()
    record = {'at_ms': time.time_ns() // 1_000_000, 'method': method, 'path': path,
              'status': response.status, 'body': raw}
    requests.write(json.dumps(record) + '\n')
    requests.flush()
    return response.status, json.loads(raw) if response.status == 200 else raw

def start(number):
    global process, log
    log = (evidence / f'wrangler-{number}.log').open('w')
    process = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    lifecycle.append({'event': 'start', 'pid': process.pid, 'at_ms': time.time_ns() // 1_000_000})
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'Wrangler exited {process.returncode}; inspect wrangler-{number}.log')
        try:
            status, state = request('/state')
            if status == 200:
                return state
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError('Wrangler did not become ready')

def stop():
    global process, log
    if process is None:
        return
    os.killpg(process.pid, signal.SIGINT)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=8)
    lifecycle.append({'event': 'stop', 'pid': process.pid, 'code': process.returncode,
                      'at_ms': time.time_ns() // 1_000_000})
    log.close()
    process = None

try:
    initial = start(1)
    assert initial['model'] == {'pending': [], 'done': []}, initial
    status, seed = request('/seed', 'POST')
    assert status == 200, seed
    jobs = seed['model']['pending']
    assert len(jobs) == 3 and seed['model']['done'] == [] and seed['alarm'] == jobs[0], seed
    assert isinstance(seed['stored_json'], str)
    assert json.loads(seed['stored_json']) == seed['model']
    (evidence / 'seed.json').write_text(json.dumps(seed, indent=2) + '\n')
    stop()
    recovered = start(2)
    assert recovered == seed, (recovered, seed)
    assert time.time() * 1000 < jobs[0], 'must recover all three jobs before first deadline'
    (evidence / 'recovered.json').write_text(json.dumps(recovered, indent=2) + '\n')
    print('Recovered all three persisted jobs before first alarm', flush=True)
    deadline = time.monotonic() + 90
    previous = []
    while time.monotonic() < deadline:
        status, state = request('/state')
        assert status == 200
        done = state['model']['done']
        assert done == jobs[:len(done)], state
        assert state['model']['pending'] == jobs[len(done):], state
        if done != previous:
            observed.append(state)
            previous = done
            print(f'Observed {len(done)} completion(s), alarm={state["alarm"]}', flush=True)
        if len(done) == 3:
            assert state['alarm'] is None, state
            break
        time.sleep(0.4)
    else:
        raise RuntimeError('Alarms did not finish within deadline')
    assert [len(x['model']['done']) for x in observed] == [1, 2, 3], observed
    status, repeat = request('/repeat', 'POST')
    assert status == 200 and repeat == state, (repeat, state)
    stop()
    restarted = start(3)
    assert restarted == state, (restarted, state)
    status, rejected = request('/seed', 'POST')
    assert status == 409, rejected
    stop()
    assert hashlib.sha256(wasm.read_bytes()).hexdigest() == wasm_hash
    logs = (evidence / 'wrangler-2.log').read_text()
    assert logs.count('"origin":"alarm"') == 3, logs
    assert logs.count('"event":"transition_saved"') == 3, logs
    result = {'passed': True, 'command': command, 'port': port, 'jobs': jobs, 'seed': seed,
              'recovered': recovered, 'observed': observed, 'repeat': repeat,
              'restarted': restarted, 'lifecycle': lifecycle, 'wasm_sha256': wasm_hash,
              'qualifications': ['Local process restart, real workerd alarms and disk persistence only',
                                 'Repeat exercises same callback path via local POST; no forced SDK redelivery',
                                 'No cloud deployment, automatic idle eviction or transactional adapter proof']}
    (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS: three SDK alarms, preserved IDs, repeat callback and second restart', flush=True)
finally:
    stop()
    requests.close()
    (evidence / 'lifecycle.json').write_text(json.dumps(lifecycle, indent=2) + '\n')
