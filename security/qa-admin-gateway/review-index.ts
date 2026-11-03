/**
 * DRAFT ONLY — NOT DEPLOYED. Intended Edge Function qa-member-review.
 * Deploy only after trusted administrator re-enrollment, private mapping
 * and service-role-only SQL RPC are verified in a disposable environment.
 * Never store a service key in GitHub Pages or Android clients.
 */
import {handleMemberReview} from './review-core.mjs';

const base=Deno.env.get('SUPABASE_URL')||'';
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const configured=/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base)&&service.length>20;

async function boundedJson(res,limit=8192){
  if(!res.body)throw Error('MISSING_BODY');
  const reader=res.body.getReader(),parts=[];
  let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>limit)throw Error('BODY_TOO_LARGE');
      parts.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const p of parts){bytes.set(p,offset);offset+=p.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

async function verifiedAuthId(token){
  if(!configured)throw Error('NOT_CONFIGURED');
  const res=await fetch(base+'/auth/v1/user',{
    method:'GET',
    headers:{apikey:service,Authorization:'Bearer '+token},
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if(res.status===401||res.status===403)return null;
  if(!res.ok)throw Error('AUTH_UNAVAILABLE');
  return (await boundedJson(res))?.id??null;
}

async function protectedRpc(name,args){
  if(!configured)throw Error('NOT_CONFIGURED');
  const res=await fetch(base+'/rest/v1/rpc/'+name,{
    method:'POST',
    headers:{apikey:service,Authorization:'Bearer '+service,
      'Content-Type':'application/json'},
    body:JSON.stringify(args),
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if(!res.ok)throw Error('PROTECTED_RPC_UNAVAILABLE');
  return boundedJson(res,8192);
}

Deno.serve(req=>handleMemberReview(req,{
  verifyBearer:verifiedAuthId,
  loadAdmin:uid=>protectedRpc('qa_svc_admin_profile',{p_auth_user_id:uid}),
  executeReview:({authUserId,action,memberId,expectedStatus,idempotencyKey,reason})=>
    protectedRpc('qa_svc_member_review',{
      p_auth_user_id:authUserId,
      p_action:action,
      p_member_id:memberId,
      p_expected_status:expectedStatus,
      p_idempotency_key:idempotencyKey,
      p_reason:reason
    })
}));
