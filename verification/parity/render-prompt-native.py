"""Compare the selected native driver with sealed Source18; never runs Source."""
from pathlib import Path
import argparse, hashlib, json, subprocess, time

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
sha = lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()
def same_json(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_json(value, right[key]) for key, value in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right

reference = json.loads(args.source.read_text())
assert reference['attempted'] == reference['passed'] == 18 and not reference['failures']
binary = args.binary.resolve()
before = sha(binary)
directory = args.output.with_suffix('.processes')
directory.mkdir(parents=True, exist_ok=False)
rows = []
for source in reference['rows']:
    original = json.loads(Path(source['response']['path']).read_text())
    assert sha(source['response']['path']) == source['response']['sha256']
    assert original == source['observation']
    source_stdout = Path(source['process']['stdout']['path'])
    assert sha(source_stdout) == source['process']['stdout']['sha256']
    assert json.loads(source_stdout.read_text()) == original
    packet = {'id': source['id'], 'arguments': original['argumentsBefore']}
    request = directory / (source['id'] + '.request.json')
    stdout = directory / (source['id'] + '.stdout')
    stderr = directory / (source['id'] + '.stderr')
    request.write_text(json.dumps(packet, ensure_ascii=True, indent=2) + '\n')
    started = time.monotonic()
    timed_out = False
    with stdout.open('wb') as out, stderr.open('wb') as err:
        try:
            process = subprocess.run([str(binary), str(request)], stdout=out, stderr=err, timeout=30)
            status = process.returncode
        except subprocess.TimeoutExpired:
            status = None
            timed_out = True
    receipt = {'command': [str(binary), str(request)], 'status': status,
               'signal': -status if status is not None and status < 0 else None,
               'timedOut': timed_out,
               'seconds': time.monotonic() - started, 'binarySha256': before,
               'request': str(request), 'requestSha256': sha(request),
               'stdout': str(stdout), 'stdoutSha256': sha(stdout),
               'stderr': str(stderr), 'stderrSha256': sha(stderr)}
    row = {'id': source['id'], 'profile': original['profile'], 'process': receipt,
           'expected': original['view'], 'passed': False}
    if status == 0:
        native = json.loads(stdout.read_text())
        row['native'] = native
        row['passed'] = (native['id'] == source['id'] and native['ok'] is True
                         and same_json(native['view'], original['view']) and stderr.read_bytes() == b'')
    rows.append(row)
    args.output.write_text(json.dumps({'source': str(args.source), 'sourceSha256': sha(args.source),
        'binary': str(binary), 'binarySha256': before, 'attempted': len(rows),
        'passed': sum(row['passed'] for row in rows), 'rows': rows}, indent=2) + '\n')
assert sha(binary) == before
result = {'source': str(args.source), 'sourceSha256': sha(args.source), 'binary': str(binary),
          'binarySha256': before, 'binaryUnchanged': True, 'attempted': 18,
          'passed': sum(row['passed'] for row in rows),
          'typedStrict': sum(row['passed'] and row['id'] != 'indices.raw-null' for row in rows),
          'runtimeQualified': sum(row['passed'] and row['id'] == 'indices.raw-null' for row in rows),
          'failures': [row['id'] for row in rows if not row['passed']], 'rows': rows,
          'SourceExecutions': 0, 'newCredit': 0}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['attempted', 'passed', 'typedStrict', 'runtimeQualified', 'failures']}))
