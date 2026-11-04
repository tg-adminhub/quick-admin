/**
 * DRAFT ONLY — DO NOT DEPLOY TO PRODUCTION.
 * Intended Supabase Edge Function: qa-admin-read (verify_jwt=true).
 * Must be deployed together with read-core.mjs and core.mjs to an isolated
 * development Supabase environment after the reviewed SQL/RPC migration.
 */
import {handleAdminRead} from './read-core.mjs';

const base = Deno.env.get('SUPABASE_URL') || '';
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const configured = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base) && service.length > 20;

async function boundedJson(response, limit=32768) {
  if(!response.body) throw Error('EMPTY_BODY');
  const reader=response.body.getReader();
  let len=0;const parts=[];
  try {
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      len+=value.byteLength;
      if(len>limit)throw Error('BODY_TOO_LARGE');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(len);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

async function authUserId(token) {
  if(!configured) throw Error('NOT_CONFIGURED');
  const response=await fetch(base+'/auth/v1/user',{
    method:'GET',
    headers:{apikey:service,Authorization:'Bearer '+token},
    redirect:'error',signal:AbortSignal.timeout(4000)
  });
  if(response.status===401||response.status===403) return null;
  if(!response.ok) throw Error('AUTH_FAILURE');
  return (await boundedJson(response))?.id ?? null;
}

async function rpc(name,args) {
  if(!configured)throw Error('NOT_CONFIGURED');
  // The service role credential is used only in this trusted Edge runtime.
  // Never embed it in the client or a response.
  const response=await fetch(base+'/rest/v1/rpc/'+name,{
    method:'POST',
    headers:{apikey:service,Authorization:'Bearer '+service,
      'Content-Type':'application/json'},
    body:JSON.stringify(args),
    redirect:'error',signal:AbortSignal.timeout(4000)
  });
  if(!response.ok)throw Error('PROTECTED_RPC_FAILURE');
  return await boundedJson(response,131072);
}

Deno.serve(req=>handleAdminRead(req,{
  verifyBearer:authUserId,
  loadAdmin:userId=>rpc('qa_svc_admin_profile',{p_auth_user_id:userId}),
  queryRead:({authUserId,resource,limit,offset})=>
    rpc('qa_svc_admin_read',{
      p_auth_user_id:authUserId,
      p_resource:resource,
      p_limit:limit,
      p_offset:offset
    })
}));
