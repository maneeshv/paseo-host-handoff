import {createHash} from 'node:crypto';
import {runProcess,sshArgs} from '@server/transport';
import {captureHelperSource} from '@server/generated-capture';
import {pullExportSchema,type PullRequest,type PullExport} from '@server/pull-protocol';
import {LIMIT} from '@server/git-state';

// Code is content-addressed in the approved private root. No source/credential bytes enter argv.
const loader=String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
(async()=>{const chunks=[];let size=0;for await(const c of process.stdin){size+=c.length;if(size>20*1024*1024)throw Error();chunks.push(c);}
const x=JSON.parse(Buffer.concat(chunks).toString()),b=x.request.binding,s=await fs.lstat(b.root);
if(await fs.realpath(b.root)!==b.root||!s.isDirectory()||s.uid!==process.getuid()||(s.mode&63)!==0)throw Error();
if(!/^[a-f0-9]{64}$/.test(x.hash)||crypto.createHash('sha256').update(x.code).digest('hex')!==x.hash)throw Error();
const dir=path.join(b.root,'.pull-helpers');try{await fs.mkdir(dir,{mode:448});}catch(e){if(e.code!=='EEXIST')throw e;}
const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&63)!==0)throw Error();
const file=path.join(dir,x.hash+'.cjs');try{await fs.writeFile(file,x.code,{flag:'wx',mode:384});}catch(e){if(e.code!=='EEXIST')throw e;}
const f=await fs.lstat(file);if(!f.isFile()||f.isSymbolicLink()||f.uid!==process.getuid()||(f.mode&63)!==0||crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')!==x.hash)throw Error();
const child=cp.spawn(b.node,[file],{stdio:['pipe','pipe','ignore'],env:{PATH:path.dirname(b.node)+':/usr/bin:/bin',HOME:process.env.HOME}});
child.stdout.pipe(process.stdout);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(x.request));child.on('error',()=>process.exitCode=1);child.on('close',code=>process.exitCode=code||0);
})().catch(()=>{process.stdout.write(JSON.stringify({ok:false,error:'Private source helper staging failed; nothing activated.'}));});`;
export interface PullTransport {run(request:PullRequest):Promise<PullExport>}
export class SshPullTransport implements PullTransport {
  run(request:PullRequest) {
    const hash=createHash('sha256').update(captureHelperSource).digest('hex');
    return runProcess('ssh',sshArgs(request.binding,loader),JSON.stringify({code:captureHelperSource,hash,request}),pullExportSchema,LIMIT*4+2*1024*1024);
  }
}
