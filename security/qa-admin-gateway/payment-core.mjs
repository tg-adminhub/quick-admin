/**
 * QUICK ADMIN payment review API — DRAFT / NOT DEPLOYED.
 * Only server-verified enrolled dev admins may use this API until the actual
 * scoped write matrix is approved. Payment state changes and license extension
 * must be handled in ONE DB transaction by a service-role-only RPC.
 *
 * Device-add payments are explicitly NOT supported by this first prototype.
 * The database RPC must refuse any note beginning with "[기기추가]|".
 */
import {ALLOWED_ORIGIN, UUID, TOKEN, verifiedProfile} from './core.mjs';

const PATH='/functions/v1/qa-payment-review';
const IDEM=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS=new Set(['payment.approve','payment.reject']);

function reply(status,body,origin,allowedOrigin){
  const headers={
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Vary':'Origin',
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff'
  };
  if(origin===allowedOrigin)headers['Access-Control-Allow-Origin']=allowedOrigin;
  return new Response(JSON.stringify(body),{status,headers});
}
async function parseBounded(req,maxBytes=2048){
  if(!req.body)throw Error('BODY_MISSING');
  const reader=req.body.getReader();
  const chunks=[];let len=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      len+=value.byteLength;
      if(len>maxBytes)throw Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(len);let pos=0;
  for(const p of chunks){bytes.set(p,pos);pos+=p.byteLength;}
  const obj=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('INVALID_OBJECT');
  return obj;
}
export function validatePaymentReview(obj){
  if(!obj||typeof obj!=='object'||Array.isArray(obj)||!ACTIONS.has(obj.action))return null;
  const approval=obj.action==='payment.approve';
  const fields=approval
    ? ['action','paymentId','expectedStatus','idempotencyKey','approvedAmount']
    : ['action','paymentId','expectedStatus','idempotencyKey','reason'];
  if(Object.keys(obj).length!==fields.length||fields.some(f=>!Object.hasOwn(obj,f)))return null;
  if(!Number.isSafeInteger(obj.paymentId)||obj.paymentId<1)return null;
  if(obj.expectedStatus!=='pending')return null;
  if(typeof obj.idempotencyKey!=='string'||!IDEM.test(obj.idempotencyKey))return null;
  if(approval){
    if(!Number.isSafeInteger(obj.approvedAmount)||obj.approvedAmount<1||obj.approvedAmount>10000000)return null;
  }else if(typeof obj.reason!=='string'||obj.reason.trim().length<1||obj.reason.trim().length>200)return null;
  return Object.freeze({
    action:obj.action,
    paymentId:obj.paymentId,
    expectedStatus:'pending',
    idempotencyKey:obj.idempotencyKey.toLowerCase(),
    approvedAmount:approval?obj.approvedAmount:null,
    reason:approval?null:obj.reason.trim()
  });
}

export async function handlePaymentReview(req,{
  verifyBearer,loadAdmin,executeReview,allowedOrigin=ALLOWED_ORIGIN
}={}){
  if(typeof verifyBearer!=='function'||typeof loadAdmin!=='function'||typeof executeReview!=='function')
    throw Error('PAYMENT_REVIEW_DEPENDENCIES_MISSING');
  const origin=req.headers.get('origin');
  if(origin!==null&&origin!==allowedOrigin)
    return reply(403,{ok:false,code:'ORIGIN_DENIED'},origin,allowedOrigin);
  const url=new URL(req.url);
  if(url.pathname!==PATH && url.pathname!==PATH+'/')
    return reply(404,{ok:false,code:'NOT_FOUND'},origin,allowedOrigin);
  if(req.method==='OPTIONS'){
    const h={
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type',
      'Access-Control-Max-Age':'600',
      'Cache-Control':'no-store','Vary':'Origin'
    };
    if(origin===allowedOrigin)h['Access-Control-Allow-Origin']=allowedOrigin;
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=='POST')
    return reply(405,{ok:false,code:'METHOD_NOT_ALLOWED'},origin,allowedOrigin);
  if(url.search||req.headers.has('cookie'))
    return reply(400,{ok:false,code:'REQUEST_NOT_ALLOWED'},origin,allowedOrigin);
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))
    return reply(415,{ok:false,code:'UNSUPPORTED_MEDIA_TYPE'},origin,allowedOrigin);
  const bearer=req.headers.get('authorization')||'';
  if(bearer.length>8200)return reply(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  const token=TOKEN.exec(bearer)?.[1];
  if(!token||token.length>8192)
    return reply(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let userId;
  try{userId=await verifyBearer(token);}
  catch{return reply(503,{ok:false,code:'AUTH_UNAVAILABLE'},origin,allowedOrigin);}
  if(typeof userId!=='string'||!UUID.test(userId))
    return reply(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let admin;
  try{admin=verifiedProfile(await loadAdmin(userId));}
  catch{return reply(503,{ok:false,code:'ADMIN_LOOKUP_UNAVAILABLE'},origin,allowedOrigin);}
  if(!admin||admin.role!=='dev')
    return reply(403,{ok:false,code:'ADMIN_WRITE_DENIED'},origin,allowedOrigin);
  let parsed;
  try{parsed=validatePaymentReview(await parseBounded(req));}
  catch{return reply(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);}
  if(!parsed)return reply(400,{ok:false,code:'INVALID_BODY'},origin,allowedOrigin);

  let outcome;
  try{outcome=await executeReview({authUserId:userId,...parsed});}
  catch{return reply(503,{ok:false,code:'PAYMENT_REVIEW_UNAVAILABLE'},origin,allowedOrigin);}
  const status=parsed.action==='payment.approve'?'approved':'rejected';
  if(!outcome||outcome.paymentId!==parsed.paymentId||outcome.status!==status||
     !['updated','duplicate'].includes(outcome.outcome))
    return reply(503,{ok:false,code:'PAYMENT_REVIEW_RESULT_INVALID'},origin,allowedOrigin);
  return reply(200,{
    ok:true,paymentId:parsed.paymentId,status,outcome:outcome.outcome
  },origin,allowedOrigin);
}
