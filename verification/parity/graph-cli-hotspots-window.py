from pathlib import Path
import ast, base64, hashlib, importlib.util, json, os, shutil, stat, subprocess, sys

PROOF = Path(sys.argv[2]).resolve()
REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
source_file = PROOF/'source-first.json'
file_hash = lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()
def runtime_environment():
    result=dict(os.environ)
    for key in ['CARGO_TARGET_DIR','DEMLIK_MUTATION_TARGET_DIR','CARGO_BUILD_TARGET_DIR','CARGO_BUILD_BUILD_DIR']:
        assert key not in result,key
    result.update(PATH='/Users/cansirin/.volta/tools/image/node/22.21.1/bin:/usr/bin:/bin',TMPDIR='/private/tmp',TZ='UTC')
    return result
def save_report(name,value): (PROOF/name).write_text(json.dumps(value,indent=2)+'\n')
source=json.loads(source_file.read_text())
specification=json.loads((HERE/'cli-hotspots-window-cases.json').read_text())
cases={row['id']:row for row in specification['cases']}
driver=json.loads(Path(sys.argv[3]).read_text())
assert Path(sys.argv[1]).resolve() == Path(driver['actualPath']).resolve(), 'actual binary argv and producer agree'
initial_sha=file_hash(driver['actualPath']);assert initial_sha==driver['sha256']
parent=Path(source['cleanup']['root']);assert parent.is_dir() and not any(parent.iterdir()), 'wrapper retains empty fixture parent'
processes=PROOF/'cli-final-processes';processes.mkdir(exist_ok=True)
rows=[];failures=[];setup=[];public=[];failure=None
digest=lambda b:hashlib.sha256(b).hexdigest()

# Execute only the frozen Python fixture-data helpers, never its Source CLI loop.
syntax=ast.parse((HERE/'cli-hotspots-window-source.py').read_text())
definitions=[node for node in syntax.body if isinstance(node,ast.FunctionDef)and node.name in ['seed','files','delta']]
assert len(definitions)==3
helpers={'Path':Path,'os':os,'stat':stat,'base64':base64,'digest':digest}
exec(compile(ast.Module(body=definitions,type_ignores=[]),'frozen-fixture-data-helpers','exec'),helpers)
snapshot,delta=helpers['files'],helpers['delta']
fixtures={key:parent/key for key in ['git','not-repo','unborn']}
readonly=parent/'readonly.txt'

def git(root,args,**dates):
    env=runtime_environment();env.update(GIT_CONFIG_NOSYSTEM='1',GIT_TERMINAL_PROMPT='0',**dates)
    cmd=['/usr/bin/git','-C',str(root),*args]
    p=subprocess.run(cmd,env=env,capture_output=True,timeout=30)
    setup.append({'argv':cmd,'dates':dates,'status':p.returncode,'stdout':p.stdout.decode('utf8','replace'),'stderr':p.stderr.decode('utf8','replace')})
    assert p.returncode==0,setup[-1]
    return p.stdout.decode().strip()

def execute(case,original,step):
    fixture=fixtures[step.get('fixture','git')]
    if 'seedOutput'in step:
        file=fixture/step['out'];file.write_text(step['seedOutput']);file.chmod(step.get('seedMode',0o644))
    if 'chmodBefore'in step:(fixture/step['out']).chmod(step['chmodBefore'])
    name=case['id']+'--'+original['id'];prefix=processes/name
    trace=Path(str(prefix)+'.trace.json')
    request={'id':name,'trace':str(trace),'argv':original['argv'],
             'compiler':'/nonexistent/explicit-tsgo','plain':True,'lateReports':True,
             'clockMs':step.get('clockMs',specification['clockMs'])}
    if 'initial'in step:request['initial']=step['initial']
    body=(json.dumps(request,ensure_ascii=True,separators=(',',':'))+'\n').encode()
    request_file=Path(str(prefix)+'.request.json');request_file.write_bytes(body)
    env=runtime_environment();env.update({k:v for k,v in original['environment'].items() if v is not None})
    if original['environment']['TZ']is None:env.pop('TZ',None)
    before=snapshot(fixture);git_before=snapshot(fixture,git=True)
    with readonly.open('rb')as fd:
        p=subprocess.run([driver['actualPath']],input=body,cwd=fixture,env=env,
            stdout=fd if step.get('badStdout')else subprocess.PIPE,
            stderr=fd if step.get('badStderr')else subprocess.PIPE,timeout=60)
    stdout,stderr=p.stdout or b'',p.stderr or b''
    stdout_file=Path(str(prefix)+'.stdout');stderr_file=Path(str(prefix)+'.stderr')
    stdout_file.write_bytes(stdout);stderr_file.write_bytes(stderr)
    after=snapshot(fixture);git_after=snapshot(fixture,git=True)
    process={'command':[driver['actualPath']],'status':p.returncode,'signal':None if p.returncode>=0 else -p.returncode,
             'cwd':str(fixture),'stdin':str(request_file),'stdinSha256':digest(body),
             'stdout':str(stdout_file),'stdoutSha256':digest(stdout),'stderr':str(stderr_file),
             'stderrSha256':digest(stderr),'binarySha256':initial_sha,'environment':original['environment']}
    errors=[];qualifications=[];frame=None
    def require(condition,message):
        if not condition:errors.append(message)
    try:
        frame=json.loads(trace.read_text());require(frame['id']==name,'actual response id')
        require(frame['exitCode']==p.returncode,'trace and actual process status')
        require(bool(frame['observedCalls']),'actual native calls')
        if frame['observedCalls'][-1].endswith('dispatch_reports_with_clock_blocking'):
            require(frame['outcome']['kind']in ['reports','reports-hotspots-refused','reports-load-refused','thrown'],'reached report dispatch result')
    except Exception as error:errors.append('protocol: '+str(error))
    require(before==original['before'],'exact before file bytes/modes')
    require(after==original['after'],'exact after file bytes/modes')
    require(git_before==git_after,'native Git bytes/modes unchanged')
    require(p.returncode==original['process']['status'],'actual Source/native process status')
    require(stdout.decode('utf8','replace')==original['process']['stdout'],'raw stdout bytes')
    uncaught=[event for event in original['events']if event.get('event')=='uncaught']
    if len(uncaught)==1 and uncaught[0].get('name')=='RangeError' and uncaught[0].get('message')=='Invalid time value':
        event=uncaught[0]
        require(frame is not None and frame['outcome']['kind']=='thrown','original RangeError remains thrown')
        if frame is not None and frame['outcome']['kind']=='thrown':
            error=frame['outcome']['error'];require(error['name']==event['name']and error['message']==event['message'],'exact original RangeError name/message')
        attempted=''.join(e['payload']for e in original['io']if e.get('op')=='stdio-write'and e['stream']=='stderr')
        require(stderr.decode('utf8','replace')==attempted,'native stderr keeps Source writes before uncaught display')
        require(original['process']['stderr'].startswith(attempted),'Source original warning prefix')
        require('RangeError: Invalid time value'in original['process']['stderr'][len(attempted):],'retained Source exception display')
        qualifications.append('Node uncaught RangeError stack/display versus native typed error envelope; actual raw stderr retained')
    elif len(uncaught)==1 and uncaught[0].get('stream')in ['stdout','stderr']:
        event=uncaught[0];require(event.get('code')=='EBADF','measured Source stream failure code')
        pending=frame['io']['pending']if frame is not None else []
        require(len(pending)==1 and pending[0]['stream']==event['stream']and pending[0]['cause']['rawCode']==9,'native original stream/cause')
        qualifications.append('Node pending-stream notification/uncaught display versus CliIo original pending error data; raw streams retained')
    else:require(stderr.decode('utf8','replace')==original['process']['stderr'],'raw stderr bytes')
    return {'id':original['id'],'request':request,'source':original,'native':{'process':process,'trace':frame,
            'before':before,'after':after,'delta':delta(before,after),'gitBefore':git_before,'gitAfter':git_after},
            'qualifications':qualifications,'errors':errors,'equalWithinDeclaredProfile':not errors}

try:
    readonly.write_text('read-only descriptor for actual failed stream writes\n');(parent/'empty-bin').mkdir()
    for root in fixtures.values():helpers['seed'](root)
    for key in ['git','unborn']:git(fixtures[key],['init','--quiet','--initial-branch=main'])
    root=fixtures['git'];git(root,['add','.']);git(root,['commit','--quiet','-m','Initial owned window fixture'],GIT_AUTHOR_DATE='2026-10-01T12:00:00Z',GIT_COMMITTER_DATE='2026-10-01T12:00:00Z')
    (root/'packages/alpha/b.ts').write_text('import { alpha } from "./a.js";\nexport function beta(n: number) { if (n > 1) return alpha(n); return 0; }\n')
    git(root,['add','packages/alpha/b.ts']);git(root,['commit','--quiet','-m','Change beta'],GIT_AUTHOR_DATE='2026-10-20T12:00:00Z',GIT_COMMITTER_DATE='2026-10-20T12:00:00Z')
    (root/'packages/second/new.ts').write_text('export function untracked() { return 9; }\n')
    frozen_initial=json.loads((PROOF/'fixture-before.json').read_text())
    assert {key:snapshot(root)for key,root in fixtures.items()}==frozen_initial
    expected_head=json.loads(source['cases'][0]['steps'][0]['process']['stdout'])['headSha']
    assert git(root,['rev-parse','HEAD'])==expected_head,'configured Git identity/commit recipe must reproduce exact Source HEAD'
    for case in source['cases']:
        definitions=cases[case['id']]['steps'];assert len(definitions)==len(case['steps'])
        steps=[execute(case,old,new)for old,new in zip(case['steps'],definitions)]
        row={'id':case['id'],'steps':steps,'qualifications':sorted({q for s in steps for q in s['qualifications']}),
             'equalWithinDeclaredProfile':all(s['equalWithinDeclaredProfile']for s in steps)}
        rows.append(row)
        if not row['equalWithinDeclaredProfile']:failures.append({'id':row['id'],'steps':[{'id':s['id'],'errors':s['errors']}for s in steps if s['errors']]})
except BaseException as error:
    failure={'type':type(error).__name__,'message':str(error)}
    raise
finally:
    if parent.exists():
        for child in parent.iterdir():
            if child.is_dir() and not child.is_symlink(): shutil.rmtree(child)
            else: child.unlink()
    report={'scope':'20 frozen actual Source CLI wholeviews, no Source replay or global registration credit',
            'source':str(source_file),'sourceSha256':file_hash(source_file),'cases':len(rows),
            'actualNativeProcesses':sum(len(r['steps'])for r in rows),'passed':sum(r['equalWithinDeclaredProfile']for r in rows),
            'strict':sum(r['equalWithinDeclaredProfile']and not r['qualifications']for r in rows),
            'qualified':sum(r['equalWithinDeclaredProfile']and bool(r['qualifications'])for r in rows),
            'failures':failures,'rows':rows,'setup':setup,'public':public,'driver':driver,'failure':failure,
            'fixtureRecipe':'Only frozen Python fixture-data helpers executed; no Source product/Date/CLI replay.',
            'cleanup':{'root':str(parent),'fixturesRemoved':not any(parent.iterdir()),'parentRetainedForWrapper':True},
            'limits':['Source/runtime exception display and stdio cause profiles remain explicitly qualified.',
                      'Source Git metadata bytes are not asserted equal to newly initialized Git metadata; each run proves its own before/after no-change.',
                      'No file/error/stdout/root string normalization; same initially-absent owned Source fixture path is recreated.',
                      'One9-action workflow is one wholeview; old80 windows remain separate.']}
    assert file_hash(driver['actualPath'])==initial_sha
    save_report('cli-pairs-final.json',report)
    print(json.dumps({k:report[k]for k in ['cases','actualNativeProcesses','passed','strict','qualified','failures','failure','cleanup']}),flush=True)
if failure or failures:raise SystemExit(1)
