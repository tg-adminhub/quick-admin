/**
 * DRAFT / NOT DEPLOYED: QUICK ADMIN server-verified identity endpoint.
 *
 * Intended Supabase Edge Function: qa-admin-gateway, verify_jwt=true.
 * Before deployment, enroll existing administrators in Supabase Auth and
 * link their verified Auth UUID to qa_private.admin_identities. There is
 * deliberately no legacy SHA-256 password or localStorage fallback.
 */
import {handleAdminGateway} from './core.mjs';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const isConfigured = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(SUPABASE_URL)
  && SERVICE_ROLE_KEY.length > 20;

async function boundedJson(res, maxBytes=32768) {
  if (!res.body) throw Error('MISSING_BODY');
  const reader = res.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) { joined.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(joined));
}

async function verifyBearer(token) {
  if (!isConfigured) throw Error('AUTH_UNAVAILABLE');
  const res = await fetch(SUPABASE_URL+'/auth/v1/user', {
    method:'GET',
    headers:{apikey:SERVICE_ROLE_KEY, Authorization:'Bearer '+token},
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if (res.status===401 || res.status===403) return null;
  if (!res.ok) throw Error('AUTH_UPSTREAM_ERROR');
  const user = await boundedJson(res);
  return typeof user?.id === 'string' ? user.id : null;
}

async function loadAdmin(userId) {
  if (!isConfigured) throw Error('ACCESS_UNAVAILABLE');
  const res = await fetch(SUPABASE_URL+'/rest/v1/rpc/qa_svc_admin_profile', {
    method:'POST',
    headers:{
      apikey:SERVICE_ROLE_KEY,
      Authorization:'Bearer '+SERVICE_ROLE_KEY,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({p_auth_user_id:userId}),
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if (!res.ok) throw Error('ACCESS_RPC_UNAVAILABLE');
  return await boundedJson(res);
}

// Never log the inbound Authorization header, full Supabase response, or service key.
Deno.serve(req => handleAdminGateway(req, {verifyBearer, loadAdmin}));
