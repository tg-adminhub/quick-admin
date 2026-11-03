/**
 * QUICK ADMIN scoped read API core — development only.
 * Do not deploy until the corresponding service-only RPC is reviewed in a
 * Supabase development environment and existing administrators are enrolled.
 *
 * 1. Verify caller's Auth JWT on the server.
 * 2. Load admin mapping by the server-verified Auth user ID, never client ID.
 * 3. Invoke a service-only RPC that independently recomputes the admin scope.
 * 4. Project only a fixed safe set of columns, checking scope again.
 */
import {ALLOWED_ORIGIN, UUID, TOKEN, verifiedProfile} from './core.mjs';

export const RESOURCES = Object.freeze({
  members: ['id','username','real_name','status','branch_id','app_type','license_expires_at'],
  payments:['id','user_id','amount','status','created_at','branch_id'],
  branches:['id','name','parent_id','type']
});

function respond(status, body, origin, allowedOrigin) {
  const headers = {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Vary':'Origin'
  };
  if (origin===allowedOrigin) headers['Access-Control-Allow-Origin']=allowedOrigin;
  return new Response(JSON.stringify(body),{status,headers});
}

function constrainedPositiveInt(value,defaultValue,min,max) {
  if(value===null) return defaultValue;
  if(!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n=Number(value);
  return Number.isSafeInteger(n) && n>=min && n<=max ? n : null;
}

function scopedRow(row,resource,profile) {
  if (!row || typeof row!=='object' || Array.isArray(row)) return false;
  if(!Number.isSafeInteger(row.id)||row.id<1) return false;
  if(resource==='payments'&&(!Number.isSafeInteger(row.user_id)||row.user_id<1)) return false;
  if(resource==='branches') {
    if (typeof row.name!=='string' || !row.name || typeof row.type!=='string') return false;
  }
  if(profile.visibleBranchIds===null) return true;
  const branchId=resource==='branches'?row.id:row.branch_id;
  return Number.isSafeInteger(branchId) && profile.visibleBranchIds.includes(branchId);
}

function safeProjection(row,fields) {
  const sanitized={};
  for(const field of fields) {
    if (Object.hasOwn(row,field)) sanitized[field]=row[field];
  }
  return sanitized;
}

export async function handleAdminRead(req, {
  verifyBearer,
  loadAdmin,
  queryRead,
  allowedOrigin=ALLOWED_ORIGIN
}={}) {
  if(typeof verifyBearer!=='function'||typeof loadAdmin!=='function'||typeof queryRead!=='function') {
    throw Error('READ_API_DEPENDENCIES_MISSING');
  }
  const origin=req.headers.get('origin');
  if(origin!==null && origin!==allowedOrigin)
    return respond(403,{ok:false,code:'ORIGIN_DENIED'},origin,allowedOrigin);
  const url=new URL(req.url);
  if(!/\/qa-admin-read\/?$/.test(url.pathname))
    return respond(404,{ok:false,code:'NOT_FOUND'},origin,allowedOrigin);
  if(req.method==='OPTIONS') {
    const h={'Cache-Control':'no-store','Vary':'Origin',
      'Access-Control-Allow-Methods':'GET, OPTIONS',
      'Access-Control-Allow-Headers':'authorization',
      'Access-Control-Max-Age':'600'};
    if(origin===allowedOrigin)h['Access-Control-Allow-Origin']=allowedOrigin;
    return new Response(null,{status:204,headers:h});
  }
  if(req.method!=='GET')
    return respond(405,{ok:false,code:'METHOD_NOT_ALLOWED'},origin,allowedOrigin);
  if(req.headers.has('cookie'))
    return respond(400,{ok:false,code:'COOKIE_NOT_ALLOWED'},origin,allowedOrigin);
  if([...url.searchParams.keys()].some(k=>!['resource','limit','offset'].includes(k)) ||
     ['resource','limit','offset'].some(k=>url.searchParams.getAll(k).length>1))
    return respond(400,{ok:false,code:'INVALID_QUERY'},origin,allowedOrigin);
  const resource=url.searchParams.get('resource');
  if(!Object.hasOwn(RESOURCES,resource||''))
    return respond(400,{ok:false,code:'RESOURCE_NOT_ALLOWED'},origin,allowedOrigin);
  const limit=constrainedPositiveInt(url.searchParams.get('limit'),25,1,100);
  const offset=constrainedPositiveInt(url.searchParams.get('offset'),0,0,10000);
  if(limit===null||offset===null)
    return respond(400,{ok:false,code:'INVALID_PAGINATION'},origin,allowedOrigin);

  const bearer=req.headers.get('authorization')||'';
  if(bearer.length>8200)
    return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  const token=TOKEN.exec(bearer)?.[1];
  if(!token||token.length>8192)
    return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);
  let userId;
  try {userId=await verifyBearer(token);}
  catch {return respond(503,{ok:false,code:'AUTH_UNAVAILABLE'},origin,allowedOrigin);}
  if(typeof userId!=='string'||!UUID.test(userId))
    return respond(401,{ok:false,code:'INVALID_SESSION'},origin,allowedOrigin);

  let admin;
  try {admin=verifiedProfile(await loadAdmin(userId));}
  catch {return respond(503,{ok:false,code:'ADMIN_LOOKUP_UNAVAILABLE'},origin,allowedOrigin);}
  if(!admin)
    return respond(403,{ok:false,code:'ADMIN_ACCESS_DENIED'},origin,allowedOrigin);

  // Do not provide settings (including secret-like values) through this API.
  // The SQL RPC must recompute role/branch scope itself using authUserId.
  let rows;
  try {rows=await queryRead({authUserId:userId,resource,limit,offset});}
  catch {return respond(503,{ok:false,code:'READ_UNAVAILABLE'},origin,allowedOrigin);}
  if(!Array.isArray(rows)||rows.length>limit ||
     rows.some(row=>!scopedRow(row,resource,admin)))
    return respond(503,{ok:false,code:'READ_SCOPE_INTEGRITY_FAILURE'},origin,allowedOrigin);
  return respond(200,{
    ok:true,
    resource,
    offset,
    limit,
    items:rows.map(row=>safeProjection(row,RESOURCES[resource])),
    morePossible:rows.length===limit
  },origin,allowedOrigin);
}
