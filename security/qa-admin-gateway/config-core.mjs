/**
 * QUICK ADMIN organization/account/settings mutation gateway — DEVELOPMENT ONLY.
 * 
 * Never deployed. The production UI still uses direct Supabase table access.
 * Only a server-verified, enabled dev admin can attempt these narrowly scoped
 * operations. The protected SQL RPC must recheck identity and row state.
 * No role escalation, hierarchy moves, password handling, deletion or secrets.
 */
import {ALLOWED_ORIGIN,UUID,TOKEN,verifiedProfile} from './core.mjs';

const PATH='/functions/v1/qa-admin-config';
const IDEM=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NAME=/^[\p{L}\p{N} _().-]{1,80}$/u;
const SETTING_KEYS=new Set(['payment_visible','maintenance_mode']);
const ACTIONS=Object.freeze({
  'branch.rename':'branches',
  'admin.rename':'admins',
  'setting.toggle':'app_settings'
});
const own=(o,k)=>Object.hasOwn(o,k);
function json(status,data,origin,allowedOrigin){
  const headers={'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','Vary':'Origin',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  if(origin===allowedOrigin)headers['Access-Control-Allow-Origin']=allowedOrigin;
  return new Response(JSON.stringify(data),{status,headers});
}
async function readBounded(req,limit=2048){
  if(!req.body)throw Error('EMPTY_BODY');
  const reader=req.body.getReader(),parts=[];let length=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>limit)throw Error('BODY_TOO_LARGE');
      parts.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(length);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error('INVALID_BODY');
  return v;
}
function hasExactKeys(v,required){
  return Object.keys(v).length===required.length&&required.every(k=>own(v,k));
}
function validName(v){
  return typeof v==='string'&&v===v.trim()&&SAFE_NAME.test(v)&&v.length<=80;
}
export function validateConfigMutation(v){
  if(!v||typeof v!=='object'||Array.isArray(v)||!own(ACTIONS,v.action)||
     typeof v.idempotencyKey!=='string'||!IDEM.test(v.idempotencyKey))
    return null;
  const base=['action','idempotencyKey'];
  if(v.action==='setting.toggle'){
    if(!hasExactKeys(v,[...base,'key','expectedValue','newValue']))return null;
    if(!SETTING_KEYS.has(v.key)||!['true','false'].includes(v.expectedValue)||
       !['true','false'].includes(v.newValue)||v.expectedValue===v.newValue)
      return null;
    return Object.freeze({action:v.action,idempotencyKey:v.idempotencyKey.toLowerCase(),
      key:v.key,expectedValue:v.expectedValue,newValue:v.newValue});
  }
  const nameTarget=v.action==='branch.rename'?'branchId':'adminId';
  if(!hasExactKeys(v,[...base,nameTarget,'expectedName','newName']))return null;
  if(!Number.isSafeInteger(v[nameTarget])||v[nameTarget]<1||
     !validName(v.expectedName)||!validName(v.newName)||
     v.expectedName===v.newName)return null;
  return Object.freeze({action:v.action,idempotencyKey:v.idempotencyKey.toLowerCase(),
    [nameTarget]:v[nameTarget],expectedName:v.expectedName,newName:v.newName});
}
export async function handleAdminConfig(req,{
  verifyBearer,loadAdmin,executeConfig,allowedOrigin=ALLOWED_ORIGIN
}={}){
  if(typeof verifyBearer!=='function'||typeof loadAdmin!=='function'||
     typeof executeConfig!=='function')throw Error('MISSING_CONFIG_DEPENDENCIES');
  const origin=req.headers.get('origin');
  if(origin!==null&&origin!==allowedOrigin)
    return json(403,{ok:false,code:'ORIGIN_DENIED'},origin,allowedOrigin);
  const url=new URL(req.url);
  if(url.pathname!==PATH&&url.pathname!==PATH+'/')
    return json(404,{ok:false,code:'NOT_FOUND'},origin,allowedOrigin);
  if(req.method==='OPTIONS'){
    const headers={'Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type',
      'Access-Control-Max-Age':'600'};
    if(origin===allowedOrigin)headers['Access-Control-Allow-Origin']=allowedOrigin;
    return new Response(null,{status:204,headers});
  }
  if(req.method!=='POST')
    return json(405,{ok:false,code:'METHOD_NOT_ALLOWED'},origin,allowedOrigin);
  if(url.search||req.headers.has('cookie'))
    return json(400,{ok:false,code:'REQUEST_NOT_ALLOWED'},origin,allowedOrigin);
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))
    return json(415,{ok:false,code:'UNSUPPORTED_MEDIA_TYPE'},origin,allowedOrigin);
  const bearer=req.headers.get('authorization')||'';
  if(bearer.length>8200)return json(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  const token=TOKEN.exec(bearer)?.[1];
  if(!token||token.length>8192)
    return json(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let userId;
  try{userId=await verifyBearer(token);}
  catch{return json(503,{ok:false,code:'AUTH_UNAVAILABLE'},origin,allowedOrigin);}
  if(typeof userId!=='string'||!UUID.test(userId))
    return json(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let admin;
  try{admin=verifiedProfile(await loadAdmin(userId));}
  catch{return json(503,{ok:false,code:'ADMIN_LOOKUP_UNAVAILABLE'},origin,allowedOrigin);}
  if(!admin||admin.role!=='dev')
    return json(403,{ok:false,code:'ADMIN_WRITE_DENIED'},origin,allowedOrigin);
  let action;
  try{action=validateConfigMutation(await readBounded(req));}
  catch{return json(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);}
  if(!action)return json(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);
  let result;
  try{result=await executeConfig({authUserId:userId,...action});}
  catch{return json(503,{ok:false,code:'CONFIG_UNAVAILABLE'},origin,allowedOrigin);}
  const target=action.branchId??action.adminId??action.key;
  if(!result||result.action!==action.action||result.target!==target||
     !['updated','duplicate'].includes(result.outcome))
    return json(503,{ok:false,code:'CONFIG_RESULT_INVALID'},origin,allowedOrigin);
  return json(200,{ok:true,action:action.action,target,outcome:result.outcome},origin,allowedOrigin);
}
