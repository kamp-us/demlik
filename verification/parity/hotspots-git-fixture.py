#!/usr/bin/env python3
"""Controlled Git executable; never changes a repository or config/identity."""
import hashlib,json,os,signal,sys
plan=json.load(open(os.environ['DEMLIK_HOTSPOTS_GIT_PLAN']))
receipt=os.environ['DEMLIK_HOTSPOTS_GIT_RECEIPT']
args=sys.argv[1:]
phase='top' if args==['rev-parse','--show-toplevel'] else 'head' if args==['rev-parse','HEAD'] else 'tracked' if args and args[0]=='ls-files' else 'log' if args and args[0]=='log' else 'unknown'
def record(value):
 with open(receipt,'a') as f:f.write(json.dumps(value,separators=(',',':'))+'\n')
record({'event':'start','phase':phase,'args':args,'cwd':os.getcwd(),'pid':os.getpid()})
def terminate(sig,_):
 record({'event':'signal','phase':phase,'pid':os.getpid(),'signal':sig})
 raise SystemExit(0)
signal.signal(signal.SIGTERM,terminate)
if plan.get('stderr'):
 data=(b'phase:'+phase.encode()+b':'+(b'\xff\xf0\x9f\x92\x00\n' if plan['stderr']=='invalid' else b'notice\n'))
 os.write(2,data);record({'event':'stderr','phase':phase,'bytes':len(data),'hex':data.hex()})
if phase==plan.get('fail'):
 os.write(2,('controlled Git '+phase+' failure\n').encode());record({'event':'exit','phase':phase,'status':7});sys.exit(7)
if phase=='top':payload=(plan['repoRoot']+'\n').encode()
elif phase=='head':payload=b'0123456789abcdef\n'
elif phase=='tracked':payload=b'alpha.ts\nzero.ts\n  spaced.ts  \n"quoted\\n.ts"\n"\\303\\251.ts"\n'
elif phase=='log':payload=b'\0\nalpha.ts\nalpha.ts\n  spaced.ts  \n"quoted\\n.ts"\n\0\nalpha.ts\n"\\303\\251.ts"\n'
else:record({'event':'exit','phase':phase,'status':9});sys.exit(9)
if phase in ('tracked','log') and not (phase=='tracked' and plan.get('bytes')):
 prefix=plan.get('prefix','').encode()
 if prefix:
  payload=b'\n'.join(prefix+line if line and line!=b'\0' else line for line in payload.split(b'\n'))
if phase=='tracked' and plan.get('bytes'):
 remaining=plan['bytes'];block=b'\n'*(64*1024);written=0
 digest=hashlib.sha256()
 for n in range(remaining,0,-len(block)):digest.update(block[:min(n,len(block))])
 record({'event':'payload','phase':phase,'construction':'newline repeated N bytes in64KiB chunks','requestedBytes':remaining,'requestedSHA256':digest.hexdigest()})
 try:
  while remaining:
   count=os.write(1,block[:min(remaining,len(block))]);remaining-=count;written+=count
 except BrokenPipeError:
  record({'event':'broken-pipe','phase':phase,'written':written});sys.exit(0)
 record({'event':'written','phase':phase,'written':written})
else:os.write(1,payload)
record({'event':'exit','phase':phase,'status':0})
