/**
 * DUO deployed API + published DEV APK inspection (read-only production smoke).
 * This script NEVER uses real credentials, registers users, or alters the DB.
 * Runs in a disposable GitHub Actions runner, NOT a developer workstation.
 */
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const PROJECT='https://pvdhdnvbgytfaydyyuat.supabase.co';
const FUNC=PROJECT+'/functions/v1/';
const apkRoot=PROJECT+'/storage/v1/object/public/duo-apk/';
const MAX_BYTES=80*1024*1024;
const TIMEOUT=15000;
const runs=[];

function pass(key,value){runs.push({key,status:'PASS',value});console.log(key+': PASS '+value);}
function fail(key,value){runs.push({key,status:'FAIL',value});console.error(key+': FAIL '+value);process.exitCode=1;}

async function request(path,opts={}){
  const c=new AbortController();
  const timer=setTimeout(()=>c.abort(),TIMEOUT);
  try{return await fetch(FUNC+path,{
    method:opts.method||'GET',
    headers:{...(opts.method==='POST'?{'Content-Type':'application/json'}:{}),...(opts.headers||{})},
    ...(opts.method==='POST'?{body:opts.body||'{}'}:{}),
    redirect:'error',cache:'no-store',signal:c.signal
  });}finally{clearTimeout(timer);}
}
async function requireStatus(key,path,method,expected,options={}){
  try{
    const r=await request(path,{method,...options});
    // Avoid printing body contents; they may contain private fields.
    if(r.status===expected)pass(key,'HTTP_'+expected);
    else fail(key,'HTTP_'+r.status+'_EXPECTED_'+expected);
    await r.body?.cancel().catch(()=>{});
  }catch(e){fail(key,'NETWORK_'+(e?.name||'error'));}
}
async function boundedDownload(url){
  if(typeof url!=='string'||!url.startsWith(apkRoot)||
    !url.endsWith('.apk')||url.includes('?')||url.includes('#'))
    throw Error('UNTRUSTED_APK_URL');
  const u=new URL(url);
  if(u.username||u.password||u.port||
    u.hostname!==new URL(PROJECT).hostname)throw Error('UNTRUSTED_HOST');
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),40000);
  try{
    const r=await fetch(url,{redirect:'error',cache:'no-store',signal:c.signal});
    if(!r.ok||!r.body)throw Error('APK_HTTP_'+r.status);
    const chunks=[],hash=createHash('sha256');
    let count=0;
    for await(const chunk of r.body){
      count+=chunk.length;
      if(count>MAX_BYTES){c.abort();throw Error('APK_TOO_LARGE');}
      hash.update(chunk);chunks.push(chunk);
    }
    if(count<10000)throw Error('APK_TOO_SMALL');
    const dir=await mkdtemp(join(tmpdir(),'duo-apk-audit-'));
    const path=join(dir,'duo-dev.apk');
    await writeFile(path,Buffer.concat(chunks));
    return {path,bytes:count,sha:hash.digest('hex')};
  }finally{clearTimeout(timer);}
}
async function main(){
  console.log('=== DUO DEPLOYED API AND DEV APK READ-ONLY SMOKE ===');
  await requireStatus('DUO_LOGIN_METHOD','duo-member-login','GET',405);
  await requireStatus('DUO_LOGIN_EMPTY_INPUT','duo-member-login','POST',401,{body:'{}'});
  await requireStatus('DUO_STATUS_WITHOUT_JWT','duo-my-status','GET',401);
  await requireStatus('DUO_STREAM_BAD_JWT','duo-stream-authorize','POST',401,{
    body:'{}',headers:{Authorization:'Bearer invalid.invalid.invalid'}
  });
  let policy;
  try{
    const r=await request('duo-dev-release-policy');
    if(r.status!==200)throw Error('HTTP_'+r.status);
    policy=await r.json();
    if(!Number.isSafeInteger(policy.latestVersionCode)||policy.latestVersionCode<1||
      !Number.isSafeInteger(policy.minVersionCode)||policy.minVersionCode<1||
      policy.minVersionCode>policy.latestVersionCode||
      !/^[a-f0-9]{64}$/.test(policy.apkSha256||''))throw Error('BAD_RELEASE_POLICY');
    pass('DUO_DEV_RELEASE_POLICY','VERSION_CODE_'+policy.latestVersionCode);
  }catch(e){fail('DUO_DEV_RELEASE_POLICY',e?.message||'unavailable');return;}
  try{
    const apk=await boundedDownload(policy.apkUrl);
    if(apk.sha!==policy.apkSha256)throw Error('SHA256_MISMATCH');
    const first=(await readFile(apk.path)).subarray(0,4).toString('hex');
    if(first!=='504b0304')throw Error('NOT_ZIP_APK');
    pass('DUO_APK_DOWNLOAD_AND_SHA','BYTES_'+apk.bytes);
    // Used only by the NEXT step in this disposable runner; path not uploaded.
    console.log('DUO_APK_LOCAL_PATH='+apk.path);
  }catch(e){fail('DUO_APK_DOWNLOAD_AND_SHA',e?.message||'unavailable');}
  console.log('=== DUO END READ_ONLY_SMOKE ===');
  if(process.exitCode)throw Error('LIVE_SMOKE_FAILED');
}
await main();
