/**
 * QUICK ADMIN member/device maintenance — DRAFT / NOT DEPLOYED.
 * Only server-verified and actively enrolled 'dev' administrators are allowed.
 * All changes must run inside a service-only transactional DB RPC which
 * rechecks permission, member/device ownership, state and idempotency.
 */
import {ALLOWED_ORIGIN, UUID, TOKEN, verifiedProfile} from './core.mjs';

export const ACTION_STATES=Object.freeze({
  'member.pause':'active',
  'member.resume':'paused',
  'device.reset_main':'bound',
  'device.reset_extra':'bound'
});
const IDEM=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH='/functions/v1/qa-member-maintenance';

function json(status,body,origin,allowedOrigin){
  const headers={
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Vary':'Origin',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer'
  };
  if(origin===allowedOrigin)headers['Access-Control-Allow-Origin']=allowedOrigin;
  return new Response(JSON.stringify(body),{status,headers});
}
async function readJsonBounded(req,maxBytes=2048){
  if(!req.body)throw Error('EMPTY_BODY');
  const reader=req.body.getReader();
  const parts=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>maxBytes)throw Error('BODY_TOO_LARGE');
      parts.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}
  const obj=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('INVALID_OBJECT');
  return obj;
}
export function validateMaintenanceBody(obj){
  if(!obj || typeof obj!=='object' || Array.isArray(obj))return null;
  const keys=Object.keys(obj);
  if(!Object.hasOwn(ACTION_STATES,obj.action))return null;
  const extra=obj.action==='device.reset_extra';
  const required=extra
    ? ['action','memberId','expectedState','idempotencyKey','deviceId']
    : ['action','memberId','expectedState','idempotencyKey'];
  if(keys.length!==required.length || required.some(k=>!Object.hasOwn(obj,k)))return null;
  if(!Number.isSafeInteger(obj.memberId)||obj.memberId<1)return null;
  if(extra && (!Number.isSafeInteger(obj.deviceId)||obj.deviceId<1))return null;
  if(obj.expectedState!==ACTION_STATES[obj.action])return null;
  if(typeof obj.idempotencyKey!=='string'||!IDEM.test(obj.idempotencyKey))return null;
  return Object.freeze({
    action:obj.action,
    memberId:obj.memberId,
    deviceId:extra?obj.deviceId:null,
    expectedState:obj.expectedState,
    idempotencyKey:obj.idempotencyKey.toLowerCase()
  });
}

export async function handleMemberMaintenance(req,{
  verifyBearer,loadAdmin,executeMutation,allowedOrigin=ALLOWED_ORIGIN
}={}){
  if(typeof verifyBearer!=='function'||typeof loadAdmin!=='function'||typeof executeMutation!=='function')
    throw Error('MAINTENANCE_DEPENDENCIES_MISSING');
  const origin=req.headers.get('origin');
  if(origin!==null&&origin!==allowedOrigin)
    return json(403,{ok:false,code:'ORIGIN_DENIED'},origin,allowedOrigin);
  const u=new URL(req.url);
  if(u.pathname!==PATH && u.pathname!==PATH+'/')
    return json(404,{ok:false,code:'NOT_FOUND'},origin,allowedOrigin);
  if(req.method==='OPTIONS'){
    const h={'Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type',
      'Access-Control-Max-Age':'600'};
    if(origin===allowedOrigin)h['Access-Control-Allow-Origin']=allowedOrigin;
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=='POST')
    return json(405,{ok:false,code:'METHOD_NOT_ALLOWED'},origin,allowedOrigin);
  if(u.search||req.headers.has('cookie'))
    return json(400,{ok:false,code:'REQUEST_NOT_ALLOWED'},origin,allowedOrigin);
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))
    return json(415,{ok:false,code:'UNSUPPORTED_MEDIA_TYPE'},origin,allowedOrigin);
  const bearer=req.headers.get('authorization')||'';
  if(bearer.length>8200)
    return json(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
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
  // Until a reviewed scoped write matrix exists, all non-dev roles are
  // denied even if the legacy browser UI currently exposes the operation.
  if(!admin||admin.role!=='dev')
    return json(403,{ok:false,code:'ADMIN_WRITE_DENIED'},origin,allowedOrigin);

  let parsed;
  try{parsed=validateMaintenanceBody(await readJsonBounded(req));}
  catch{return json(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);}
  if(!parsed)return json(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);
  let result;
  try{
    result=await executeMutation({authUserId:userId,...parsed});
  }catch{
    return json(503,{ok:false,code:'MAINTENANCE_UNAVAILABLE'},origin,allowedOrigin);
  }
  if(!result || result.memberId!==parsed.memberId || result.action!==parsed.action ||
     !['updated','duplicate'].includes(result.outcome))
    return json(503,{ok:false,code:'MAINTENANCE_RESULT_INVALID'},origin,allowedOrigin);
  return json(200,{
    ok:true,memberId:parsed.memberId,action:parsed.action,outcome:result.outcome
  },origin,allowedOrigin);
}
