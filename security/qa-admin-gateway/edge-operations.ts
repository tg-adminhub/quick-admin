/**
 * Shared development-only Edge dependencies for maintenance/payment drafts.
 * NOT DEPLOYED. Never expose SUPABASE_SERVICE_ROLE_KEY to GitHub Pages or APK.
 */
const base=Deno.env.get('SUPABASE_URL')||'';
const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const ready=/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base)&&service.length>20;

async function boundedJson(res,max=8192){
  if(!res.body)throw Error('MISSING_BODY');
  const reader=res.body.getReader(),chunks=[];
  let len=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      len+=value.byteLength;
      if(len>max)throw Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
  }finally{
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  const bytes=new Uint8Array(len);let pos=0;
  for(const part of chunks){bytes.set(part,pos);pos+=part.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}

export async function verifyBearer(token){
  if(!ready)throw Error('UNCONFIGURED');
  const res=await fetch(base+'/auth/v1/user',{
    method:'GET',
    headers:{apikey:service,Authorization:'Bearer '+token},
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if(res.status===401||res.status===403)return null;
  if(!res.ok)throw Error('AUTH_UNAVAILABLE');
  const user=await boundedJson(res);
  return typeof user?.id==='string'?user.id:null;
}

export async function protectedRpc(name,args){
  const allowed=new Set([
    'qa_svc_admin_profile',
    'qa_svc_member_maintenance',
    'qa_svc_payment_review'
  ]);
  if(!ready||!allowed.has(name))throw Error('RPC_NOT_CONFIGURED');
  const res=await fetch(base+'/rest/v1/rpc/'+name,{
    method:'POST',
    headers:{
      apikey:service,
      Authorization:'Bearer '+service,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(args),
    redirect:'error',
    signal:AbortSignal.timeout(4000)
  });
  if(!res.ok)throw Error('RPC_UNAVAILABLE');
  return boundedJson(res);
}
