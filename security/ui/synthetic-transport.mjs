/**
 * QUICK ADMIN security pilot: SYNTHETIC DATA ONLY. No network access.
 * Never import this transport into the production website.
 */
const TEST_TOKEN='demo.jwt.token';
const CLIENT_ORIGIN='https://pvdhdnvbgytfaydyyuat.supabase.co';
const DEMO_ADMIN=Object.freeze({
  id:999,username:'demo-admin',name:'가상 개발자',role:'dev',
  branchId:null,visibleBranchIds:null
});

const response=(status,body)=>new Response(JSON.stringify(body),{
  status,headers:{'Content-Type':'application/json'}
});
const closed=(code,status)=>response(status,{ok:false,code});

export function createSyntheticTransport({randomUUID}={}){
  if(typeof randomUUID!=='function')throw Error('RANDOM_UUID_REQUIRED');
  const members=[
    {id:101,username:'synthetic-a',real_name:'가상회원 A',status:'pending',
      branch_id:3,app_type:'toss',license_expires_at:null,paused:false,mainBound:true},
    {id:102,username:'synthetic-b',real_name:'가상회원 B',status:'approved',
      branch_id:3,app_type:'grab',license_expires_at:'2099-01-01T00:00:00Z',
      paused:false,mainBound:true}
  ];
  const payments=[{id:201,user_id:102,amount:35000,status:'pending',
    created_at:'2026-11-03T06:00:00Z',branch_id:3}];
  const branches=[{id:3,name:'가상 지점',parent_id:null,type:'branch'}];
  const idem=new Map();
  const messages=[];

  const fetchImpl=async (url,options={})=>{
    // This transport serves in-memory fake results only; no network requests.
    const u=new URL(url);
    if(u.origin!==CLIENT_ORIGIN||!u.pathname.startsWith('/functions/v1/'))
      return closed('INVALID_DEMO_PATH',404);
    if(options.headers?.Authorization!=='Bearer '+TEST_TOKEN)
      return closed('INVALID_SESSION',401);
    const path=u.pathname.split('/').pop();

    if(path==='qa-admin-gateway' && options.method==='GET')
      return response(200,{ok:true,admin:DEMO_ADMIN});

    if(path==='qa-admin-read' && options.method==='GET'){
      const resource=u.searchParams.get('resource');
      const source={members,payments,branches}[resource];
      if(!source)return closed('RESOURCE_NOT_ALLOWED',400);
      const limit=Number(u.searchParams.get('limit')),offset=Number(u.searchParams.get('offset'));
      if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset)||
         limit<1||limit>100||offset<0||offset>10000)return closed('BAD_PAGE',400);
      return response(200,{ok:true,resource,limit,offset,
        items:source.slice(offset,offset+limit)});
    }

    if(options.method!=='POST')return closed('METHOD_NOT_ALLOWED',405);
    let body;
    try{body=JSON.parse(options.body);}
    catch{return closed('INVALID_BODY',400);}
    const action=body?.action;
    if(typeof action!=='string'||typeof body.idempotencyKey!=='string')
      return closed('INVALID_ACTION',400);
    if(idem.has(body.idempotencyKey)){
      const prev=idem.get(body.idempotencyKey);
      if(prev.action!==action||prev.id!==(body.memberId??body.paymentId))
        return closed('IDEMPOTENCY_CONFLICT',409);
      return response(200,{ok:true,...prev.result,outcome:'duplicate'});
    }
    let result;
    if(path==='qa-member-review' && ['member.approve','member.reject'].includes(action)){
      const m=members.find(x=>x.id===body.memberId);
      if(!m||m.status!=='pending')return closed('MEMBER_NOT_PENDING',409);
      m.status=action==='member.approve'?'approved':'rejected';
      result={memberId:m.id,status:m.status};
    }else if(path==='qa-member-maintenance' &&
      ['member.pause','member.resume','device.reset_main'].includes(action)){
      const m=members.find(x=>x.id===body.memberId);
      if(!m||m.status!=='approved')return closed('MEMBER_NOT_APPROVED',409);
      if(action==='member.pause'&&m.paused)return closed('MEMBER_ALREADY_PAUSED',409);
      if(action==='member.resume'&&!m.paused)return closed('MEMBER_NOT_PAUSED',409);
      if(action==='device.reset_main'&&!m.mainBound)return closed('DEVICE_ALREADY_RESET',409);
      if(action==='member.pause')m.paused=true;
      if(action==='member.resume')m.paused=false;
      if(action==='device.reset_main')m.mainBound=false;
      result={memberId:m.id,action};
    }else if(path==='qa-payment-review' &&
      ['payment.approve','payment.reject'].includes(action)){
      const p=payments.find(x=>x.id===body.paymentId);
      if(!p||p.status!=='pending')return closed('PAYMENT_NOT_PENDING',409);
      p.status=action==='payment.approve'?'approved':'rejected';
      result={paymentId:p.id,status:p.status};
    }else return closed('DEMO_UNSUPPORTED_ACTION',400);

    idem.set(body.idempotencyKey,{action,id:body.memberId??body.paymentId,result});
    messages.push({action,id:body.memberId??body.paymentId,synthetic:true});
    return response(200,{ok:true,...result,outcome:'updated'});
  };
  return Object.freeze({
    getAccessToken:async()=>TEST_TOKEN,
    fetchImpl,
    randomUUID,
    messages,
    /** May be used to reset the demo by constructing a fresh transport. */
    syntheticOnly:true
  });
}
