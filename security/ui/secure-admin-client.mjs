/**
 * QUICK ADMIN protected API client — DEVELOPMENT BRANCH ONLY.
 * No browser direct-table access, no legacy adminId session restoration,
 * no service_role key, no acceptance of client-side role as authorization.
 *
 * API adapter expects a Supabase Auth access token. All authorization MUST
 * be re-verified inside each server Edge/RPC request.
 */
export const PROJECT_ORIGIN='https://pvdhdnvbgytfaydyyuat.supabase.co';
const API='/functions/v1/';
const PATHS=Object.freeze({
  identity:'qa-admin-gateway',
  read:'qa-admin-read',
  memberReview:'qa-member-review',
  maintenance:'qa-member-maintenance',
  paymentReview:'qa-payment-review'
});
const SAFE_FIELDS=Object.freeze({
  members:['id','username','real_name','status','branch_id','app_type','license_expires_at'],
  payments:['id','user_id','amount','status','created_at','branch_id'],
  branches:['id','name','parent_id','type']
});
const RESOURCES=new Set(Object.keys(SAFE_FIELDS));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TOKEN=/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
const ACTIONS=Object.freeze({
  approveMember:{key:'memberReview',action:'member.approve',status:'pending'},
  rejectMember:{key:'memberReview',action:'member.reject',status:'pending'},
  pauseMember:{key:'maintenance',action:'member.pause',status:'active'},
  resumeMember:{key:'maintenance',action:'member.resume',status:'paused'},
  resetMainDevice:{key:'maintenance',action:'device.reset_main',status:'bound'},
  resetExtraDevice:{key:'maintenance',action:'device.reset_extra',status:'bound'},
  approvePayment:{key:'paymentReview',action:'payment.approve',status:'pending'},
  rejectPayment:{key:'paymentReview',action:'payment.reject',status:'pending'}
});
const EXTRA=Object.freeze({
  approveMember:[],
  rejectMember:['reason'],
  pauseMember:[],
  resumeMember:[],
  resetMainDevice:[],
  resetExtraDevice:['deviceId'],
  approvePayment:['approvedAmount'],
  rejectPayment:['reason']
});
const isPositiveInt=x=>Number.isSafeInteger(x)&&x>0;

export class GatewayError extends Error {
  constructor(code,status=0){super(code);this.name='GatewayError';this.code=code;this.status=status;}
}
function isObject(obj){return obj!==null&&typeof obj==='object'&&!Array.isArray(obj);}
function requireFields(body,expected){
  if(!isObject(body)||Object.keys(body).length!==expected.length||expected.some(k=>!Object.hasOwn(body,k)))
    throw new GatewayError('INVALID_ACTION_INPUT');
}
function validateIntent(type,id,extra,idempotencyKey){
  const spec=ACTIONS[type];
  if(!spec||!isPositiveInt(id)||!isObject(extra))
    throw new GatewayError('INVALID_ACTION_INPUT');
  const fields=EXTRA[type];
  requireFields(extra,fields);
  if(!UUID.test(idempotencyKey))throw new GatewayError('INVALID_IDEMPOTENCY_KEY');
  if(fields.includes('reason')&&
    (typeof extra.reason!=='string'||extra.reason.trim().length<1||extra.reason.trim().length>200))
    throw new GatewayError('INVALID_REASON');
  if(fields.includes('approvedAmount')&&
    (!isPositiveInt(extra.approvedAmount)||extra.approvedAmount>10000000))
    throw new GatewayError('INVALID_AMOUNT');
  if(fields.includes('deviceId')&&!isPositiveInt(extra.deviceId))
    throw new GatewayError('INVALID_DEVICE_ID');
  const idField=spec.key==='paymentReview'?'paymentId':'memberId';
  const body={action:spec.action,[idField]:id,
    expectedStatus:spec.status,idempotencyKey:idempotencyKey.toLowerCase()};
  if(spec.key==='maintenance'){
    delete body.expectedStatus;
    body.expectedState=spec.status;
  }
  for(const field of fields)body[field]=field==='reason'?extra[field].trim():extra[field];
  return Object.freeze({type,key:spec.key,id,body:Object.freeze(body)});
}
function ensureProfile(data){
  if(!isObject(data)||data.ok!==true||!isObject(data.admin))
    throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  const a=data.admin;
  if(!isPositiveInt(a.id)||!['dev','master','branch','sub'].includes(a.role)||
     typeof a.username!=='string'||a.username.length<1||a.username.length>128||
     typeof a.name!=='string'||a.name.length<1||a.name.length>128)
    throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  if(a.role==='dev'){
    if(a.visibleBranchIds!==null)throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  }else if(!isPositiveInt(a.branchId)||!Array.isArray(a.visibleBranchIds)||
     !a.visibleBranchIds.includes(a.branchId)||a.visibleBranchIds.some(x=>!isPositiveInt(x)))
    throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  return Object.freeze({id:a.id,username:a.username,name:a.name,role:a.role,
    branchId:a.branchId??null,
    visibleBranchIds:a.visibleBranchIds===null?null:Object.freeze([...a.visibleBranchIds])});
}
function validateList(data,resource,limit,offset){
  if(!isObject(data)||data.ok!==true||data.resource!==resource||
     data.limit!==limit||data.offset!==offset||
     !Array.isArray(data.items)||data.items.length>limit)
    throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  for(const row of data.items){
    if(!isObject(row)||!isPositiveInt(row.id))throw new GatewayError('INVALID_GATEWAY_RESPONSE');
  }
  return Object.freeze(data.items.map(row=>{
    const safe={};
    for(const field of SAFE_FIELDS[resource])
      if(Object.hasOwn(row,field))safe[field]=row[field];
    return Object.freeze(safe);
  }));
}

export function createProtectedAdminClient({
  getAccessToken,
  fetchImpl,
  randomUUID,
  apiOrigin=PROJECT_ORIGIN
}={}){
  if(typeof getAccessToken!=='function'||typeof fetchImpl!=='function'||typeof randomUUID!=='function')
    throw new GatewayError('MISSING_CLIENT_DEPENDENCY');
  // No arbitrary origins, untrusted URLs, or server-key credentials.
  if(apiOrigin!==PROJECT_ORIGIN)throw new GatewayError('UNTRUSTED_API_ORIGIN');

  async function request(endpoint,{method='GET',query='',body}={}){
    if(!Object.hasOwn(PATHS,endpoint))throw new GatewayError('ENDPOINT_NOT_ALLOWED');
    let token;
    try{token=await getAccessToken();}
    catch{throw new GatewayError('AUTH_REQUIRED',401);}
    if(typeof token!=='string'||!TOKEN.test(token)||token.length>8192)
      throw new GatewayError('AUTH_REQUIRED',401);

    const url=apiOrigin+API+PATHS[endpoint]+query;
    const headers={Authorization:'Bearer '+token,Accept:'application/json'};
    if(method==='POST')headers['Content-Type']='application/json';
    let res;
    try{
      res=await fetchImpl(url,{method,headers,
        ...(method==='POST'?{body:JSON.stringify(body)}:{}),
        credentials:'omit',redirect:'error',cache:'no-store'});
    }catch{throw new GatewayError('NETWORK_UNAVAILABLE');}
    if(!res||typeof res.status!=='number'||typeof res.json!=='function')
      throw new GatewayError('INVALID_HTTP_RESPONSE');
    if(res.status===401)throw new GatewayError('SESSION_EXPIRED',401);
    if(res.status===403)throw new GatewayError('ADMIN_ACCESS_DENIED',403);
    if(!res.ok)throw new GatewayError('GATEWAY_UNAVAILABLE',res.status);
    let data;
    try{data=await res.json();}
    catch{throw new GatewayError('INVALID_GATEWAY_RESPONSE');}
    if(!isObject(data)||data.ok!==true)throw new GatewayError('INVALID_GATEWAY_RESPONSE');
    return data;
  }

  return Object.freeze({
    async getIdentity(){
      return ensureProfile(await request('identity'));
    },
    async getList(resource,{limit=25,offset=0}={}){
      if(!RESOURCES.has(resource)||!Number.isSafeInteger(limit)||limit<1||limit>100||
         !Number.isSafeInteger(offset)||offset<0||offset>10000)
        throw new GatewayError('INVALID_QUERY');
      const query='?'+new URLSearchParams({resource,limit:String(limit),offset:String(offset)});
      return validateList(await request('read',{query}),resource,limit,offset);
    },
    /** Prepare an intent ONCE; reuse the same immutable payload for safe retries. */
    prepare(type,id,extra={}){
      const key=randomUUID();
      if(typeof key!=='string')throw new GatewayError('INVALID_IDEMPOTENCY_KEY');
      return validateIntent(type,id,extra,key);
    },
    async submit(intent){
      if(!isObject(intent)||typeof intent.type!=='string'||!isObject(intent.body))
        throw new GatewayError('INVALID_ACTION_INPUT');
      const {type,id,body}=intent;
      if(!ACTIONS[type])throw new GatewayError('INVALID_ACTION_INPUT');
      const spec=ACTIONS[type],extras={};
      for(const k of EXTRA[type])extras[k]=body[k];
      // Revalidate all parameters, dropping any unknown or client-controlled fields.
      const canonical=validateIntent(type,id,extras,body.idempotencyKey);
      if(Object.keys(body).length!==Object.keys(canonical.body).length||
         Object.keys(canonical.body).some(k=>body[k]!==canonical.body[k]))
        throw new GatewayError('INVALID_ACTION_INPUT');
      const result=await request(spec.key,{method:'POST',body:canonical.body});
      const idField=spec.key==='paymentReview'?'paymentId':'memberId';
      const status=spec.key==='memberReview'?
        (type==='approveMember'?'approved':'rejected'):
        spec.key==='paymentReview'?(type==='approvePayment'?'approved':'rejected'):null;
      if(result[idField]!==id||!['updated','duplicate'].includes(result.outcome)||
         (status!==null&&result.status!==status)||
         (spec.key==='maintenance'&&result.action!==spec.action))
        throw new GatewayError('INVALID_GATEWAY_RESPONSE');
      return Object.freeze({id,action:spec.action,outcome:result.outcome,status});
    }
  });
}

/**
 * Browser-only Supabase Auth adapter for re-enrolled email identities.
 * No direct public database table calls are made. Existing legacy admin
 * username/SHA-256 passwords must NOT be used for this new authentication.
 */
export function createSupabaseAuthAdapter(supabase){
  if(!supabase||!supabase.auth||
     typeof supabase.auth.signInWithPassword!=='function'||
     typeof supabase.auth.getSession!=='function'||
     typeof supabase.auth.signOut!=='function')
    throw new GatewayError('AUTH_ADAPTER_UNAVAILABLE');
  return Object.freeze({
    async signIn(email,password){
      if(typeof email!=='string'||!email.includes('@')||
         typeof password!=='string'||!password)
        throw new GatewayError('INVALID_CREDENTIAL_INPUT');
      const {error}=await supabase.auth.signInWithPassword({email:email.trim(),password});
      if(error)throw new GatewayError('SIGN_IN_FAILED',401);
    },
    async getAccessToken(){
      const {data,error}=await supabase.auth.getSession();
      if(error||typeof data?.session?.access_token!=='string')
        throw new GatewayError('AUTH_REQUIRED',401);
      // It is only sent to the server; the server MUST reverify JWT and mapping.
      return data.session.access_token;
    },
    async signOut(){const {error}=await supabase.auth.signOut();if(error)throw new GatewayError('SIGN_OUT_FAILED');}
  });
}
