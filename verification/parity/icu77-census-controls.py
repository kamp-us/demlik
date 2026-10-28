"""K-only four-fault suite: one registered default target, no cache copies."""
from pathlib import Path
import base64, gzip, hashlib, json, os, shutil, subprocess, sys, tempfile, time
assert len(sys.argv) == 2, 'pass the frozen K component proof directory'
P = Path(sys.argv[1]).resolve()
source = Path(__file__).resolve().parents[2]
head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
assert not subprocess.check_output(['git','status','--porcelain'],cwd=source,text=True)
hash_file = lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()
mutations = [
 ('library-directory-order','crates/code-graph/src/boundaries/libraries/census.rs','dirs.sort_by(|a, b| collation.compare(&a.1, &b.1));','dirs.sort_by(|a, b| collation.compare(&b.1, &a.1));',['library-multiple-directories']),
 ('worker-order','crates/code-graph/src/boundaries/deployables/census.rs','by_worker.sort_by(|a, b| collation.compare(&a.2, &b.2));','by_worker.sort_by(|a, b| collation.compare(&b.2, &a.2));',['counts-and-owners']),
 ('linear-insertion-schedule','crates/code-graph/src/text/v8_sort.rs','let middle = left + (right - left) / 2;','let middle = right - 1;',['schedule-63-alternating-tile-runs','schedule-64-staggered-runs','schedule-129-staggered-runs']),
 ('equal-reference-substitution','crates/code-graph/src/boundaries/deployables/census.rs','.map(|index| rows[index])','.map(|index| rows.iter().copied().find(|candidate| candidate.file == rows[index].file && candidate.line.to_bits() == rows[index].line.to_bits() && candidate.binding == rows[index].binding).unwrap())',['same-object-and-equal-values']),
]
preflight = []
for name,file,before,after,_ in mutations:
    text = (source/file).read_text()
    assert text.count(before) == 1, (name, 'needle count', text.count(before))
    assert after not in text, (name, 'replacement already present')
    mutated = text.replace(before,after,1)
    assert mutated.replace(after,before,1) == text
    assert len(mutated)-len(text) == len(after)-len(before)
    preflight.append({'name':name,'file':file,'needleCount':1,'singleReplacementReversible':True,'lengthDelta':len(after)-len(before),'originalSha256':hash_file(source/file),'mutantSha256':hashlib.sha256(mutated.encode()).hexdigest()})
(P/'control-needle-preflight.json').write_text(json.dumps(preflight,indent=2)+'\n')
evidence = P/'controls'
evidence.mkdir()
parent = Path(tempfile.mkdtemp(prefix='demlik-check-icu77-census-controls-01a16c9d-',dir='/private/tmp')).resolve()
root = parent/'repo'
runtime = parent/'runtime'
env = dict(os.environ)
for key in ['CARGO_TARGET_DIR','DEMLIK_MUTATION_TARGET_DIR','CARGO_BUILD_TARGET_DIR','CARGO_BUILD_BUILD_DIR']: env.pop(key,None)
env.update(TMPDIR='/private/tmp',CARGO_NET_OFFLINE='true',CARGO_BUILD_JOBS='1',CARGO_INCREMENTAL='0',CARGO_PROFILE_DEV_DEBUG='0',CARGO_PROFILE_TEST_DEBUG='0',DEMLIK_ICU77_PYTHON=sys.executable,DEMLIK_ICU77_PREPARED=str(root/'target/icu77/prepared.json'),RUST_ICU_MAJOR_VERSION_NUMBER='77',RUST_ICU_LINK_SEARCH_DIR=str(root/'target/icu77/install/lib'))
report = {'sourceCommit':head,'worktree':str(root),'defaultTarget':str(root/'target'),'controls':[],'registered':False,'newSourceExecutions':0,'semanticDetections':0}
original = {}
registered = False
failure = None

def save(): (evidence/'controls.json').write_text(json.dumps(report,indent=2)+'\n')

def command(label,args):
    stdout,stderr = evidence/(label+'.stdout'),evidence/(label+'.stderr')
    start = time.monotonic()
    with stdout.open('w') as out,stderr.open('w') as err: result = subprocess.run(args,cwd=root,env=env,stdout=out,stderr=err)
    return {'command':args,'exit':result.returncode,'seconds':time.monotonic()-start,'stdout':str(stdout),'stdoutSha256':hash_file(stdout),'stderr':str(stderr),'stderrSha256':hash_file(stderr)}


def retain(event,file,label):
    file = Path(file)
    assert file.resolve().is_relative_to(root/'target')
    assert Path(event['manifest_path']).resolve().is_relative_to(root)
    digest = hash_file(file)
    out = evidence/(label+'-'+digest+'.gz')
    with file.open('rb') as inp,gzip.open(out,'wb',compresslevel=1) as dest: shutil.copyfileobj(inp,dest)
    assert hashlib.sha256(gzip.decompress(out.read_bytes())).hexdigest() == digest
    return {'actualArtifact':str(file),'sha256':digest,'preservedGzip':str(out),'gzipSha256':hash_file(out),'compilerArtifact':event}


def observe(binary,row,label):
    payload = (json.dumps(row['input'])+'\n').encode()
    result = subprocess.run([str(binary),str(runtime)],cwd=root,env=env,input=payload,capture_output=True,timeout=30)
    stdin,stdout,stderr = [evidence/(label+suffix) for suffix in ['.stdin','.stdout','.stderr']]
    stdin.write_bytes(payload);stdout.write_bytes(result.stdout);stderr.write_bytes(result.stderr)
    rec = {'id':row['id'],'status':result.returncode,'binarySha256':hash_file(binary),'stdinSha256':hash_file(stdin),'stdoutSha256':hash_file(stdout),'stderrSha256':hash_file(stderr)}
    assert result.returncode == 0 and result.stderr == b'', ('nonsemantic process failure',rec)
    frame = json.loads(result.stdout)
    assert set(frame) == {'id','output','observedCalls'} and frame['id'] == row['id'] and frame['observedCalls'], ('protocol failure',rec)
    output = frame['output']
    if row['input']['mode'] == 'deployable':
        view = {key:value for key,value in output.items() if key != 'identity'}
        source_identity = row['sourceOriginalReferenceFacts']
        identity_equal = len(source_identity) == len(output['identity']) and all(a['inputIndices'] == b['originalIndices'] and b['allOriginalRows'] and not b['aliasInputMaterializedAsSeparateOwnedRows'] for a,b in zip(source_identity,output['identity']))
    else:
        view = output
        identity_equal = True
    rec.update(protocolValid=True,observedCalls=frame['observedCalls'],source=row['source'],native=view,sourceOriginalReferences=row.get('sourceOriginalReferenceFacts'),nativeOriginalReferences=output.get('identity') if isinstance(output,dict) else None,wholeviewMatches=view == row['source'],identityMatches=identity_equal)
    return rec

try:
    created = subprocess.run(['git','worktree','add','--detach',str(root),head],cwd=source,capture_output=True,text=True)
    report['creation'] = {'exit':created.returncode,'stdout':created.stdout,'stderr':created.stderr}
    assert created.returncode == 0,created.stderr
    registered = True;report['registered'] = True;save()
    for relative in ['node_modules','verification/parity/node_modules','packages/tea/node_modules','packages/code-graph/node_modules']: os.symlink(source/relative,root/relative,target_is_directory=True)
    for _,file,_,_,_ in mutations: original[file] = (root/file).read_bytes()
    report['baselineOwnerHashes'] = {file:hashlib.sha256(data).hexdigest() for file,data in original.items()}
    archive = '/Users/cansirin/Documents/development/demlik/.fabrika/rust-port-goal-01a16c9d/evidence/icu4c77-trial/downloads/icu4c-77_1-src.tgz'
    report['icuPreparation'] = command('icu-prepare',[sys.executable,str(root/'tools/icu77/prepare.py'),'prepare','--host','aarch64-apple-darwin','--target','aarch64-apple-darwin','--source-archive',archive,'--cargo',env['CARGO']]);save()
    assert report['icuPreparation']['exit'] == 0
    runtime = parent/'runtime';runtime.mkdir()
    for name in ['Z','a','ten','two']:
        directory = runtime/'packages'/name;directory.mkdir(parents=True);(directory/'package.json').write_text(json.dumps({'name':'@k/'+name}));(directory/'package.json').chmod(0o644)
    assert hash_file(P/'green-native-pairs.json') == 'd01b27bcfb180caf216a1d1410de7a2665b56f78b5d0a1726452dfa5665a2913'
    raw = json.loads((P/'green-native-pairs.json').read_text())
    rows = {row['id']:row for row in raw['observations']}
    selected = json.loads((P/'cargo4.json').read_text())['actualArtifacts']
    baseline = next(row for row in selected if row['name'] == 'icu77_census_probe_driver')
    baseline_binary = root/'target/parity/immutable-baseline';baseline_binary.parent.mkdir(parents=True);baseline_binary.write_bytes(gzip.decompress(Path(baseline['preservedGzip']).read_bytes()));baseline_binary.chmod(0o755)
    assert hash_file(baseline_binary) == baseline['sha256']
    report['baseline'] = {'sha256':baseline['sha256'],'sourceCargoSelection':baseline,'executions':[]}
    for ident in dict.fromkeys(ident for item in mutations for ident in item[4]):
        result = observe(baseline_binary,rows[ident],'baseline-'+ident)
        report['baseline']['executions'].append(result);save()
        assert result['wholeviewMatches'] and result['identityMatches'], ('baseline mismatch',ident)
    for name,file,before,after,candidates in mutations:
        for target,body in original.items(): (root/target).write_bytes(body)
        text = original[file].decode()
        expected_occurrences = 1
        assert text.count(before) == expected_occurrences,(name,text.count(before))
        (root/file).write_text(text.replace(before,after,1))
        row = {'name':name,'file':file,'before':before,'after':after,'originalSha256':hashlib.sha256(original[file]).hexdigest(),'mutantSha256':hash_file(root/file),'candidates':candidates}
        build = command(name+'-cargo',[env['CARGO'],'build','--locked','--offline','-p','demlik-code-graph','--example','icu77_census_probe_driver','--message-format=json']);row['build'] = build;report['controls'].append(row);save()
        events = [json.loads(line) for line in Path(build['stdout']).read_text().splitlines() if line]
        events = [event for event in events if event.get('reason') == 'compiler-artifact']
        libraries = [event for event in events if event['target']['name'] == 'demlik_code_graph' and event['target']['kind'] == ['lib'] and not event['profile']['test']]
        drivers = [event for event in events if event['target']['name'] == 'icu77_census_probe_driver' and event.get('executable')]
        row['partialArtifacts'] = []
        for event in libraries:
            row['partialArtifacts'].append(retain(event,next(file for file in event['filenames'] if file.endswith('.rlib')),name+'-library'))
        for event in drivers:
            row['partialArtifacts'].append(retain(event,event['executable'],name+'-driver'))
        save()
        assert build['exit'] == 0,('compiler/setup failure;0semanticcredit',name)
        assert len(libraries) == len(drivers) == 1
        lib, driver = libraries[0], drivers[0]
        assert lib['fresh'] is False and driver['fresh'] is False,('modified library/consumer not fresh:false',name)
        row['library'] = next(record for record in row['partialArtifacts'] if record['compilerArtifact']['target']['name'] == 'demlik_code_graph')
        row['driver'] = next(record for record in row['partialArtifacts'] if record['compilerArtifact']['target']['name'] == 'icu77_census_probe_driver')
        save()
        row['observations'] = []
        for ident in candidates:
            result = observe(driver['executable'],rows[ident],name+'-'+ident);row['observations'].append(result);save()
            if not result['wholeviewMatches'] or not result['identityMatches']:
                row['namedWitness'] = ident;row['semanticDetection'] = True;break
        assert row.get('semanticDetection'), ('no named semantic witness',name)
        for target,body in original.items(): (root/target).write_bytes(body)
        assert all((root/target).read_bytes() == body for target,body in original.items())
        row['ownersRestored'] = True;report['semanticDetections'] += 1;save()
    report['status'] = 'four-compiled-semantic-controls-passed'
except BaseException as error:
    report['status'] = 'failed';report['failure'] = repr(error);failure = error
finally:
    if registered:
        for target,body in original.items(): (root/target).write_bytes(body)
        report['finalOwnersRestored'] = all((root/target).read_bytes() == body for target,body in original.items())
        removed = subprocess.run(['git','worktree','remove','--force',str(root)],cwd=source,capture_output=True,text=True)
        report['cleanup'] = {'exit':removed.returncode,'worktreeRemoved':not root.exists(),'defaultTargetRemoved':not(root/'target').exists(),'stderr':removed.stderr}
        if runtime.exists(): shutil.rmtree(runtime)
        if not list(parent.iterdir()): parent.rmdir()
        report['cleanup']['parentRemoved'] = not parent.exists()
        if removed.returncode: failure = failure or RuntimeError('control cleanup failed')
    if not registered and parent.exists() and not list(parent.iterdir()): parent.rmdir()
    save()
print(json.dumps({'status':report['status'],'semanticDetections':report['semanticDetections'],'cleanup':report.get('cleanup')}))
if failure: raise failure
