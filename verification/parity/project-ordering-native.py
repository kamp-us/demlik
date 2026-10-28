"""Execute native public project/CLI paths against an immutable, saved Source20 oracle."""
import argparse,base64,hashlib,json,os,pathlib,shutil,stat,subprocess,sys,time
sha=lambda b:hashlib.sha256(b).hexdigest()
def digest(p):return sha(pathlib.Path(p).read_bytes())
def write(p,d):pathlib.Path(p).parent.mkdir(parents=True,exist_ok=True);pathlib.Path(p).write_text(json.dumps(d,indent=2,ensure_ascii=True)+'\n')
def snapshot(root):
 out={}
 def visit(directory):
  for p in directory.iterdir():
   if p.name=='.git':continue
   key=str(p.relative_to(root))
   if p.is_symlink():out[key]={'symlink':os.readlink(p)}
   elif p.is_dir():visit(p)
   elif p.is_file():
    info=p.stat();row={'mode':stat.S_IMODE(info.st_mode),'bytes':info.st_size}
    try:row['base64']=base64.b64encode(p.read_bytes()).decode()
    except OSError as e:row['readError']={'name':type(e).__name__,'message':str(e),'errno':e.errno,'path':str(p)}
    out[key]=row
 visit(root)
 return dict(sorted(out.items()))
def comparable(files):
 # Host read diagnostics are retained verbatim. File equality covers bytes/mode,
 # or mode/length/readability for the one intentionally unreadable fixture.
 return {k:({'mode':v['mode'],'bytes':v['bytes'],'readable':False} if 'readError'in v else v) for k,v in files.items()}
def reset(row,runtime):
 directory=pathlib.Path(row['directory']);assert directory.parent==runtime and directory.is_dir()
 for p in directory.iterdir():
  if p.name=='.git':continue
  if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
  else:
   if not p.is_symlink():p.chmod(0o600)
   p.unlink()
 for name,info in row['before'].items():
  p=directory/name;assert p.is_relative_to(directory);p.parent.mkdir(parents=True,exist_ok=True)
  if 'symlink'in info:p.symlink_to(info['symlink'])
  else:
   b=base64.b64decode(info['base64']) if 'base64'in info else row['input']['files'][name].encode()
   p.write_bytes(b);p.chmod(info['mode'])
 return directory
def diffs(a,b,at='$',out=None):
 out=[] if out is None else out
 if len(out)>=24:return out
 if type(a)!=type(b):out.append({'field':at,'difference':'types','source':type(a).__name__,'native':type(b).__name__})
 elif isinstance(a,dict):
  if set(a)!=set(b):out.append({'field':at,'difference':'keys','source':sorted(a),'native':sorted(b)})
  for k in a.keys()&b.keys():diffs(a[k],b[k],at+'.'+k,out)
 elif isinstance(a,list):
  if len(a)!=len(b):out.append({'field':at,'difference':'length','source':len(a),'native':len(b)})
  for i,(x,y) in enumerate(zip(a,b)):diffs(x,y,at+f'[{i}]',out)
 elif a!=b:out.append({'field':at,'difference':'value','source':a if not isinstance(a,str) or len(a)<300 else {'bytes':len(a.encode()),'sha256':sha(a.encode())},'native':b if not isinstance(b,str) or len(b)<300 else {'bytes':len(b.encode()),'sha256':sha(b.encode())}})
 return out

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--source',required=True);ap.add_argument('--binary',required=True);ap.add_argument('--cli-binary',required=True);ap.add_argument('--compiler',required=True);ap.add_argument('--output',required=True);ap.add_argument('--only-id');a=ap.parse_args()
 assert not any(k in os.environ for k in ['CARGO_TARGET_DIR','DEMLIK_MUTATION_TARGET_DIR','CARGO_BUILD_TARGET_DIR','CARGO_BUILD_BUILD_DIR'])
 source_file=pathlib.Path(a.source).resolve();source=json.loads(source_file.read_text());assert source['complete'] and len(source['rows'])==20
 assert source['engine']=={'node':'v22.21.1','v8':'12.4.254.21-node.33','icu':'77.1','locale':'en-US'}
 root=pathlib.Path(__file__).resolve().parents[2] if pathlib.Path(__file__).parent.name=='parity' else pathlib.Path('/private/tmp/demlik-project-ordering-native-01a16c9d')
 for relative,expected in source['sourceHashes'].items():assert digest(root/relative)==expected,(relative,'frozen Source/fixture drift')
 out=pathlib.Path(a.output).resolve();assert not out.exists(),'new run report required';out.parent.mkdir(parents=True,exist_ok=True)
 runtime=pathlib.Path(source['runtime']);assert runtime.is_dir()
 binaries={key:{'path':str(pathlib.Path(value).resolve()),'sha256':digest(value)} for key,value in [('project',a.binary),('cli',a.cli_binary),('compiler',a.compiler)]}
 env=dict(os.environ);env['TMPDIR']='/private/tmp';env['PATH']='/Users/cansirin/.volta/tools/image/node/22.21.1/bin:'+env.get('PATH','')
 report={'source':str(source_file),'sourceSha256':digest(source_file),'sourceEngine':source['engine'],'sourceHashes':source['sourceHashes'],'binaries':binaries,'rows':[],'processes':[],'failures':[],'newCredit':0,'limits':['Raw Source host IO/error stack receipts are retained, not asserted identical to Rust/Go internal syscalls.','File comparison covers readable bytes+mode, or mode/length/readability for locked.ts; raw host read diagnostics retained.','One native execution per direct row and per CLI action; CLI actions remain two whole workflow cases.']}
 def run(row,directory,action=None):
  ident=row['id']+('.'+action['id'] if action else '')
  folder=out.parent/(out.stem+'.processes')/ident;folder.mkdir(parents=True,exist_ok=False)
  if action:
   request={'id':ident,'trace':str(folder/'response.json'),'argv':[str(directory),*action['flags']],'compiler':binaries['compiler']['path'],'plain':True,'lateReports':True}
   if 'initial'in action:request['initial']=action['initial']
   argv=[binaries['cli']['path']];stdin=json.dumps(request,ensure_ascii=False).encode();response=folder/'response.json'
  else:
   request={'input':row['input'],'directory':str(directory)};argv=[binaries['project']['path'],str(folder/'request.json')];stdin=None;response=folder/'response.json'
  write(folder/'request.json',request)
  stdin_record = {}
  if stdin is not None:
   stdin_file = folder/'native.stdin.request.json'
   stdin_file.write_bytes(stdin)
   stdin_record = {'stdin':str(stdin_file),'stdinSha256':sha(stdin),'stdinBytes':len(stdin)}
  write(folder/'input-receipt.json',{'request':str(folder/'request.json'),'requestSha256':digest(folder/'request.json'),**stdin_record})
  started=time.time()
  try:p=subprocess.run(argv,cwd=directory,input=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=120)
  except (subprocess.TimeoutExpired,OSError) as e:
   (folder/'native.stdout').write_bytes(getattr(e,'stdout',None) or b'');(folder/'native.stderr').write_bytes(getattr(e,'stderr',None) or b'');write(folder/'failure.json',{'kind':'timeout' if isinstance(e,subprocess.TimeoutExpired) else 'spawn','message':str(e),'seconds':120,**stdin_record});raise
  (folder/'native.stdout').write_bytes(p.stdout);(folder/'native.stderr').write_bytes(p.stderr)
  process={'id':ident,'argv':argv,'cwd':str(directory),'status':p.returncode,'request':str(folder/'request.json'),'requestSha256':digest(folder/'request.json'),'stdout':str(folder/'native.stdout'),'stdoutSha256':sha(p.stdout),'stderr':str(folder/'native.stderr'),'stderrSha256':sha(p.stderr),'seconds':time.time()-started,'binarySha256':binaries['cli' if action else 'project']['sha256'],**stdin_record}
  if not action:response.write_bytes(p.stdout)
  write(folder/'process.json',process);report['processes'].append(process)
  body=json.loads(response.read_bytes());process['response']=str(response);process['responseSha256']=digest(response);write(folder/'process.json',process)
  if action:
   assert body['exitCode']==p.returncode,'protocol: native process versus receipt exit'
  else:assert p.returncode==0 and not p.stderr,'protocol: native direct process'
  return body,process,p.stdout.decode(),p.stderr.decode()
 for row in source['rows']:
  if a.only_id and row['id']!=a.only_id:continue
  current={'id':row['id'],'input':row['input'],'reference':row['observation'],'native':None,'passed':False};phase='setup'
  try:
   directory=reset(row,runtime);before=snapshot(directory);write(out.parent/(out.stem+'.files')/(row['id']+'.before.json'),before)
   assert comparable(before)==comparable(row['before']),'setup: exact frozen starting file facts'
   if row['input']['mode']=='cli':
    steps=[]
    for action,expected in zip(row['input']['actions'],row['observation']):
     for file in action.get('remove',[]):(directory/file).unlink()
     before_action=snapshot(directory);phase='process';body,process,stdout,stderr=run(row,directory,action);after_action=snapshot(directory)
     actual={'id':action['id'],'view':{'kind':'cli','exitCode':body['exitCode']},'trace':body,'stdout':stdout,'stderr':stderr,'before':before_action,'after':after_action,'process':process}
     steps.append(actual);current['native']=steps;write(out.parent/(out.stem+'.files')/(row['id']+'.workflow.json'),steps)
     phase='semantic'
     mismatch=diffs(expected['view'],actual['view'])+diffs(expected['stdout'],stdout,'$.stdout')+diffs(expected['stderr'],stderr,'$.stderr')+diffs(comparable(expected['before']),comparable(before_action),'$.before')+diffs(comparable(expected['after']),comparable(after_action),'$.after')
     if mismatch:raise AssertionError(json.dumps(mismatch))
     if any(flag=='--out' for flag in action['flags']):
      ack=next(x for x in body['writeObservations'] if x['stream']=='stderr' and x['payload'].startswith('code-graph: wrote '));name=action['flags'][action['flags'].index('--out')+1];assert ack['fileAtAck']==list((directory/name).read_bytes()),'file bytes exist before acknowledgement'
   else:
    phase='process';body,process,stdout,stderr=run(row,directory);current['native']=body;phase='semantic';mismatch=diffs(row['observation']['view'],body['view']);assert not mismatch,json.dumps(mismatch)
   after=snapshot(directory);write(out.parent/(out.stem+'.files')/(row['id']+'.after.json'),after);assert comparable(after)==comparable(row['after']),'semantic: final file facts';current['passed']=True
  except Exception as e:
   current['failure']={'phase':phase,'name':type(e).__name__,'message':str(e)};report['failures'].append({'id':row['id'],**current['failure']})
  report['rows'].append(current);write(out,report)
 assert not a.only_id or len(report['rows'])==1
 for value in binaries.values():assert digest(value['path'])==value['sha256'],'executed binary changed'
 report.update({'observations':len(report['rows']),'passed':sum(x['passed'] for x in report['rows']),'qualified':0,'processCount':len(report['processes']),'sourceExecutions':0,'complete':True,'binaryHashesAfter':{k:digest(v['path']) for k,v in binaries.items()}});write(out,report)
 print(json.dumps({k:report[k] for k in ['observations','passed','qualified','processCount','failures']}))
 return bool(report['failures'])
if __name__=='__main__':raise SystemExit(main())
