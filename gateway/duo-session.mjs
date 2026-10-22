/** Actual DUO member-session verifier for a Node >=20 gateway. No ZAPGO JWT. */
const ENDPOINT='https://pvdhdnvbgytfaydyyuat.supabase.co/functions/v1/duo-stream-authorize';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class DuoSessionError extends Error {
  constructor(code,status){super(code);this.name='DuoSessionError';this.code=code;this.httpStatus=status;}
}
async function readBoundedJson(response){
  if(!response.body)throw new DuoSessionError('AUTH_UNAVAILABLE',503);
  const reader=response.body.getReader();const chunks=[];let length=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>16384)throw Error('LIMIT');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(length);let at=0;for(const value of chunks){bytes.set(value,at);at+=value.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function createDuoSessionValidator({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=12000}={}){
  if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>15000)throw Error('INVALID_AUTH_CONFIGURATION');
  return async function validateDuoSession(token){
    if(typeof token!=='string'||token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new DuoSessionError('INVALID_SESSION',401);
    try{
      const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(timeoutMs)});
      if(response.status===401)throw new DuoSessionError('INVALID_SESSION',401);
      if(response.status===403)throw new DuoSessionError('DUO_ACCESS_DENIED',403);
      if(response.status!==200)throw new DuoSessionError('AUTH_UNAVAILABLE',503);
      const p=await readBoundedJson(response);
      if(p?.ok!==true||p.appAccess!==true||typeof p.accountId!=='string'||!UUID.test(p.accountId))throw new DuoSessionError('AUTH_UNAVAILABLE',503);
      const until=Date.parse(p.validUntil),tokenExpiry=Date.parse(p.tokenExpiresAt),licenseExpiry=Date.parse(p.licenseExpiresAt);
      const expiresAt=Math.min(until,tokenExpiry,licenseExpiry,now()+30000);
      if(!Number.isFinite(expiresAt)||expiresAt<=now())throw new DuoSessionError('DUO_ACCESS_EXPIRED',403);
      return Object.freeze({accountId:p.accountId,approved:true,dualAllowed:p.dualAccess===true,expiresAt,revalidateAfterMs:Math.min(15000,Math.max(1000,expiresAt-now()-1000))});
    }catch(e){if(e instanceof DuoSessionError)throw e;throw new DuoSessionError('AUTH_UNAVAILABLE',503);}
  };
}
