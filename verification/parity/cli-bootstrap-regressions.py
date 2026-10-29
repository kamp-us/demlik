from pathlib import Path
import base64,hashlib,json,os,stat,subprocess,time
import argparse,shutil
parser=argparse.ArgumentParser()
parser.add_argument('--evidence',required=True,type=Path)
parser.add_argument('--source-proof',required=True,type=Path)
parser.add_argument('--binary',required=True,type=Path)
parser.add_argument('--compiler-manifest',required=True,type=Path)
parser.add_argument('--freeze',action='store_true')
parser.add_argument('--node',type=Path)
parser.add_argument('--source-entry',type=Path)
parser.add_argument('--runtime',type=Path)
args=parser.parse_args()
P=args.evidence.resolve()
P.mkdir(exist_ok=False,parents=True)
S=args.source_proof.resolve()
binary=args.binary.resolve()
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
save=lambda f,v:Path(f).write_text(json.dumps(v,indent=2,ensure_ascii=True)+'\n')
source=json.loads((S/'source-first.json').read_text());defs=json.loads((S/'cases.json').read_text());fixtures=json.loads((S/'fixture-inputs.json').read_text())
if args.freeze:
 old_runtime=fixtures['runtime']
 def reroot(value):
  if isinstance(value,str):return value.replace(old_runtime,str(args.runtime.resolve()))
  if isinstance(value,list):return [reroot(v) for v in value]
  if isinstance(value,dict):return {k:reroot(v) for k,v in value.items()}
  return value
 defs=reroot(defs);fixtures=reroot(fixtures)
 for group in fixtures['before'].values():
  for item in group.values():
   if item['kind']=='file':
    raw=base64.b64decode(item['base64'])
    raw=raw.replace(old_runtime.encode(),str(args.runtime.resolve()).encode())
    item['base64']=base64.b64encode(raw).decode()
 save(P/'cases.json',defs);save(P/'fixture-inputs.json',fixtures)
 save(P/'handoff.json',{'kind':'fresh unchanged Source replay of retained original18 cases','originalProof':str(S),'normalization':'none; fixture inputs were rooted before either execution'})
else:
 assert json.loads((S/'comparison.json').read_text())['status']=='source-frozen'

runtime=Path(fixtures['runtime']);assert not runtime.exists();runtime.mkdir(mode=0o700)
env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','LC_ALL','PNPM_HOME','VOLTA_HOME']}
env.pop('FORCE_COLOR', None)
env['DEMLIK_CODE_GRAPH_COMPILER_MANIFEST']=str(args.compiler_manifest.resolve())
env.update(TZ='UTC',TMPDIR='/private/tmp',NO_COLOR='1',TERM='dumb',COLUMNS='80')
for key in ['project','go','config']:
 root=Path(fixtures[key]);root.mkdir()
 for name,item in fixtures['before'][key].items():
  f=root/name
  if item['kind']=='directory':f.mkdir(parents=True,exist_ok=True)
  elif item['kind']=='file':f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(base64.b64decode(item['base64']))
  else:raise AssertionError('unexpected fixture symlink')
  f.chmod(item['mode'])
 if key!='config':
  q=subprocess.run(['/usr/bin/git','-C',str(root),'init','--quiet','--initial-branch=main'],capture_output=True,env=env)
  assert q.returncode==0,(q.stdout,q.stderr)

def snapshot(root):
 result={}
 for f in sorted(root.rglob('*')):
  rel=f.relative_to(root)
  if '.git' in rel.parts:continue
  mode=stat.S_IMODE(f.lstat().st_mode)
  if f.is_file():
   data=f.read_bytes();result[str(rel)]={'kind':'file','mode':mode,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'base64':base64.b64encode(data).decode()}
  elif f.is_dir():result[str(rel)]={'kind':'directory','mode':mode}
  else:raise AssertionError('unexpected runtime symlink')
 return result

before_binary=sha(binary);rows=[];failures=[]
for case,reference in zip(defs['cases'],source['rows']):
 assert case['id']==reference['id'];row={'id':case['id'],'steps':[],'qualified':case['id']=='out.directory-uncaught'}
 for step,old in zip(case['steps'],reference['steps']):
  root=Path(fixtures['go'] if step['fixture']=='go-invoice' else fixtures['project'])
  if 'editBefore' in step:(root/step['editBefore']['path']).write_text(step['editBefore']['utf8'])
  folder=P/'native'/case['id']/step['id'];folder.mkdir(parents=True)
  command=([str(args.node),str(args.source_entry)] if args.freeze else [str(binary)])+step['argv'];save(folder/'request.json',{'command':command,'cwd':str(root),'stdinBytes':0,'environment':{k:v for k,v in env.items() if k!='HOME'}})
  (folder/'stdin').write_bytes(b'');before=snapshot(root);save(folder/'files-before.json',before);start=time.monotonic()
  with(folder/'stdin').open('rb') as inp,(folder/'stdout').open('wb') as out,(folder/'stderr').open('wb') as err:
   q=subprocess.run(command,cwd=root,env=env,stdin=inp,stdout=out,stderr=err,timeout=90)
  after=snapshot(root);save(folder/'files-after.json',after)
  result={'id':step['id'],'command':command,'cwd':str(root),'status':q.returncode,'seconds':time.monotonic()-start,'requestFile':str(folder/'request.json'),'requestSha256':sha(folder/'request.json'),'filesBefore':str(folder/'files-before.json'),'filesBeforeSha256':sha(folder/'files-before.json'),'filesAfter':str(folder/'files-after.json'),'filesAfterSha256':sha(folder/'files-after.json')}
  for name in ['stdin','stdout','stderr']:result[name]=str(folder/name);result[name+'Sha256']=sha(folder/name);result[name+'Bytes']=(folder/name).stat().st_size
  save(folder/'process.json',result)
  if args.freeze:
   result['differences']=[];row['steps'].append(result)
   assert result['status']==old['process']['status'],(case['id'],step['id'],result['status'])
   continue
  expected=old['process'];diffs=[]
  if result['status']!=expected['status']:diffs.append('status')
  if (folder/'stdout').read_bytes()!=Path(expected['stdout']).read_bytes():diffs.append('stdout')
  if before!=json.loads(Path(expected['filesBefore']).read_text()):diffs.append('filesBefore')
  if after!=json.loads(Path(expected['filesAfter']).read_text()):diffs.append('filesAfter')
  stderr_equal=(folder/'stderr').read_bytes()==Path(expected['stderr']).read_bytes()
  if row['qualified']:
   if q.returncode!=1 or not(folder/'stderr').read_bytes() or not(root/'out-is-directory').is_dir():diffs.append('raw-file-failure-contract')
   result['qualification']='Source uncaught Node stack versus native typed file-write error display; raw stderr retained, no normalization'
   result['rawStderrEqual']=stderr_equal
  elif not stderr_equal:diffs.append('stderr')
  result['differences']=diffs;row['steps'].append(result)
  if diffs:failures.append({'id':case['id'],'step':step['id'],'differences':diffs,'nativeProcess':str(folder/'process.json'),'SourceProcess':str(Path(expected['stdout']).parent/'process.json')})
 rows.append(row)
 save(P/'comparison.json',{'status':'running','binary':str(binary),'binarySha256':before_binary,'SourceProof':str(S/'handoff.json'),'rows':rows,'failures':failures})
 print(json.dumps({'id':case['id'],'matched':not any(s['differences'] for s in row['steps']),'qualified':row['qualified']}),flush=True)
if args.freeze:
 save(P/'source-first.json',{'rows':[{'id':r['id'],'steps':[{'id':s['id'],'process':s} for s in r['steps']]} for r in rows]})
 save(P/'comparison.json',{'status':'source-frozen','observations':18,'nativeCliProcesses':0,'SourceProcesses':sum(len(r['steps']) for r in rows),'sourceEntrySha256':sha(args.source_entry)})
 shutil.rmtree(runtime)
 print('Fresh Source18 full processes frozen before native replay')
 raise SystemExit(0)
assert sha(binary)==before_binary
result={'status':'passed' if not failures else 'failed','observations':18,'strictPassed':sum(not r['qualified'] and not any(s['differences'] for s in r['steps']) for r in rows),'qualifiedPassed':sum(r['qualified'] and not any(s['differences'] for s in r['steps']) for r in rows),'nativeCliProcesses':sum(len(r['steps']) for r in rows),'SourceCaseReplays':0,'binary':str(binary),'binarySha256':before_binary,'SourceProof':str(S/'handoff.json'),'SourceProofSha256':sha(S/'handoff.json'),'rows':rows,'failures':failures,'runtime':str(runtime),'qualification':'Failed-out raw stderr is retained qualified, not exact or normalized; all17 other full process/stream/filesystem views must match exactly.'}
save(P/'comparison.json',result);shutil.rmtree(runtime);print(json.dumps({k:result[k] for k in ['status','observations','strictPassed','qualifiedPassed','nativeCliProcesses']}));raise SystemExit(bool(failures))
