/**
 * QUICK ADMIN configuration API browser adapter — NOT DEPLOYED.
 * Allows only individually prepared, immutable safe mutations. A token is
 * supplied by Supabase Auth and freshly verified at the Edge on every call.
 * No service_role key or public-table .from() access appears in this client.
 */
import {PROJECT_ORIGIN,GatewayError} from './secure-admin-client.mjs';
import {validateConfigMutation} from '../qa-admin-gateway/config-core.mjs';

const TOKEN=/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
const PATH=PROJECT_ORIGIN+'/functions/v1/qa-admin-config';
const exactKeys=(a,b)=>Object.keys(a).length===Object.keys(b).length&&
  Object.keys(b).every(k=>Object.hasOwn(a,k)&&a[k]===b[k]);
const targetOf=b=>b.branchId??b.adminId??b.key;
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);

export function createConfigClient({getAccessToken,fetchImpl,randomUUID}={}){
  if(typeof getAccessToken!=='function'||typeof fetchImpl!=='function'||
     typeof randomUUID!=='function')throw new GatewayError('MISSING_CLIENT_DEPENDENCY');

  return Object.freeze({
    prepare(input){
      if(!isObject(input)||Object.hasOwn(input,'idempotencyKey'))
        throw new GatewayError('INVALID_ACTION_INPUT');
      const body=validateConfigMutation({...input,idempotencyKey:randomUUID()});
      if(!body)throw new GatewayError('INVALID_ACTION_INPUT');
      return Object.freeze({body});
    },
    async submit(intent){
      if(!isObject(intent)||!isObject(intent.body)||Object.keys(intent).length!==1)
        throw new GatewayError('INVALID_ACTION_INPUT');
      const body=validateConfigMutation(intent.body);
      if(!body||!exactKeys(intent.body,body))
        throw new GatewayError('INVALID_ACTION_INPUT');
      let token;
      try{token=await getAccessToken();}
      catch{throw new GatewayError('AUTH_REQUIRED',401);}
      if(typeof token!=='string'||!TOKEN.test(token)||token.length>8192)
        throw new GatewayError('AUTH_REQUIRED',401);
      let res;
      try{
        res=await fetchImpl(PATH,{method:'POST',
          headers:{Authorization:'Bearer '+token,Accept:'application/json',
            'Content-Type':'application/json'},
          body:JSON.stringify(body),credentials:'omit',redirect:'error',cache:'no-store'});
      }catch{throw new GatewayError('NETWORK_UNAVAILABLE');}
      if(!res||typeof res.status!=='number'||typeof res.json!=='function')
        throw new GatewayError('INVALID_HTTP_RESPONSE');
      if(res.status===401)throw new GatewayError('SESSION_EXPIRED',401);
      if(res.status===403)throw new GatewayError('ADMIN_ACCESS_DENIED',403);
      if(!res.ok)throw new GatewayError('GATEWAY_UNAVAILABLE',res.status);
      let data;
      try{data=await res.json();}
      catch{throw new GatewayError('INVALID_GATEWAY_RESPONSE');}
      if(!isObject(data)||data.ok!==true||data.action!==body.action||
        data.target!==targetOf(body)||!['updated','duplicate'].includes(data.outcome))
        throw new GatewayError('INVALID_GATEWAY_RESPONSE');
      return Object.freeze({action:body.action,target:data.target,outcome:data.outcome});
    }
  });
}
