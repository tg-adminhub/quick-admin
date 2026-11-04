/**
 * QUICK ADMIN privileged member-review API — DRAFT, NEVER DEPLOY DIRECTLY.
 *
 * Only dev administrators are allowed until a reviewed per-role write policy
 * exists. All identity and permission claims must be recomputed server-side;
 * a service-only transactional RPC is responsible for locking, scope checking,
 * approval license semantics, idempotency and an audit trail.
 */
import {ALLOWED_ORIGIN, UUID, TOKEN, verifiedProfile} from './core.mjs';

const ACTIONS = Object.freeze({
  'member.approve': 'approved',
  'member.reject': 'rejected'
});
const IDEMPOTENCY = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function respond(status, payload, origin, allowedOrigin) {
  const h={
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Vary':'Origin'
  };
  if(origin===allowedOrigin)h['Access-Control-Allow-Origin']=allowedOrigin;
  return new Response(JSON.stringify(payload),{status,headers:h});
}

async function boundedJson(req, maxBytes=4096) {
  if(!req.body) throw Error('BODY_REQUIRED');
  const r=req.body.getReader(), parts=[];
  let len=0;
  try {
    for(;;) {
      const {done,value}=await r.read();
      if(done)break;
      len+=value.byteLength;
      if(len>maxBytes)throw Error('BODY_TOO_LARGE');
      parts.push(value);
    }
  } finally {
    await r.cancel().catch(()=>{});
    r.releaseLock();
  }
  const bytes=new Uint8Array(len);let off=0;
  for(const part of parts){bytes.set(part,off);off+=part.byteLength;}
  const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error('OBJECT_REQUIRED');
  return v;
}

function validateReviewBody(body) {
  const keys=Object.keys(body).sort();
  const required=['action','expectedStatus','idempotencyKey','memberId'];
  const optional=['reason'];
  if(required.some(k=>!Object.hasOwn(body,k))||
     keys.some(k=>![...required,...optional].includes(k)))return null;
  if(!Object.hasOwn(ACTIONS,body.action))return null;
  if(!Number.isSafeInteger(body.memberId)||body.memberId<1)return null;
  if(body.expectedStatus!=='pending')return null;
  if(typeof body.idempotencyKey!=='string'||!IDEMPOTENCY.test(body.idempotencyKey))return null;
  if(body.action==='member.reject') {
    if(typeof body.reason!=='string')return null;
    const reason=body.reason.trim();
    if(reason.length<1||reason.length>200)return null;
    return {action:body.action,memberId:body.memberId,expectedStatus:'pending',idempotencyKey:body.idempotencyKey.toLowerCase(),reason};
  }
  if(Object.hasOwn(body,'reason'))return null;
  return {action:body.action,memberId:body.memberId,expectedStatus:'pending',idempotencyKey:body.idempotencyKey.toLowerCase(),reason:null};
}

export async function handleMemberReview(req,{
  verifyBearer,
  loadAdmin,
  executeReview,
  allowedOrigin=ALLOWED_ORIGIN
}={}) {
  if(typeof verifyBearer!=='function'||typeof loadAdmin!=='function'||typeof executeReview!=='function')
    throw Error('REVIEW_DEPENDENCIES_MISSING');
  const origin=req.headers.get('origin');
  if(origin!==null&&origin!==allowedOrigin)
    return respond(403,{ok:false,code:'ORIGIN_DENIED'},origin,allowedOrigin);
  const url=new URL(req.url);
  if(!/^\/functions\/v1\/qa-member-review\/?$/.test(url.pathname))
    return respond(404,{ok:false,code:'NOT_FOUND'},origin,allowedOrigin);
  if(req.method==='OPTIONS') {
    const h={'Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type','Access-Control-Max-Age':'600'};
    if(origin===allowedOrigin)h['Access-Control-Allow-Origin']=allowedOrigin;
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=='POST')return respond(405,{ok:false,code:'METHOD_NOT_ALLOWED'},origin,allowedOrigin);
  if(url.search||req.headers.has('cookie'))
    return respond(400,{ok:false,code:'REQUEST_NOT_ALLOWED'},origin,allowedOrigin);
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))
    return respond(415,{ok:false,code:'UNSUPPORTED_MEDIA_TYPE'},origin,allowedOrigin);

  const bearer=req.headers.get('authorization')||'';
  if(bearer.length>8200)return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  const token=TOKEN.exec(bearer)?.[1];
  if(!token||token.length>8192)
    return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let userId;
  try {userId=await verifyBearer(token);}
  catch{return respond(503,{ok:false,code:'AUTH_UNAVAILABLE'},origin,allowedOrigin);}
  if(typeof userId!=='string'||!UUID.test(userId))
    return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);

  let admin;
  try {admin=verifiedProfile(await loadAdmin(userId));}
  catch{return respond(503,{ok:false,code:'ADMIN_LOOKUP_UNAVAILABLE'},origin,allowedOrigin);}
  if(!admin||admin.role!=='dev')
    return respond(403,{ok:false,code:'ADMIN_WRITE_DENIED'},origin,allowedOrigin);

  let body,request;
  try {body=await boundedJson(req);request=validateReviewBody(body);}
  catch{return respond(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);}
  if(!request)return respond(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);

  let outcome;
  try {
    // IMPORTANT: protected RPC must independently verify the role, action,
    // exact target row state and idempotency key under the same DB transaction.
    outcome=await executeReview({authUserId:userId,...request});
  }catch {
    return respond(503,{ok:false,code:'REVIEW_UNAVAILABLE'},origin,allowedOrigin);
  }

  const expectedStatus=ACTIONS[request.action];
  if(!outcome||outcome.memberId!==request.memberId||outcome.status!==expectedStatus||
    !['updated','duplicate'].includes(outcome.outcome)) {
    return respond(503,{ok:false,code:'REVIEW_RESULT_INVALID'},origin,allowedOrigin);
  }
  return respond(200,{ok:true,memberId:request.memberId,status:expectedStatus,outcome:outcome.outcome},origin,allowedOrigin);
}
