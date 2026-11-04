import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDuoRiderResolver} from './duo-rider-resolver.mjs';

const t=Date.parse('2026-11-04T00:00:00Z');
const user='00000000-0000-4000-8000-000000000001';
const record={id:'rider_001',status:'active'};
const bound={
  duoAccountId:user,sourceRiderId:record.id,enabled:true,
  operatorVerifiedSameMember:true,sources:['인성1','인성2'],
  validUntil:new Date(t+60000).toISOString()
};
function fixture(changes={}){
  let count={auth:0,map:0,rider:0,member:0};
  const config={
    validateDuo:async()=>{count.auth++;return {accountId:user,approved:true,expiresAt:t+30000}},
    loadMapping:async()=>{count.map++;return {...bound}},
    loadRider:async()=>{count.rider++;return {...record}},
    allowRider:async()=>{count.member++;return true},
    clock:()=>t,...changes
  };
  return {config,count};
}
test('approved same-member binding maps both authorized sources without issuing other tokens',async()=>{
  const {config,count}=fixture();
  const resolve=createDuoRiderResolver(config);
  const a=await resolve('duo-member-token','인성1');
  const b=await resolve('duo-member-token','인성2');
  assert.equal(a.port,12000);
  assert.equal(b.port,12200);
  assert.equal(a.rider.id,record.id);
  assert.equal(a.expiresAt,t+15000);
  assert.equal(count.auth,2);
});
test('unknown source blocked before user or upstream lookup',async()=>{
  const {config,count}=fixture();
  await assert.rejects(createDuoRiderResolver(config)('x','unknown'),/SOURCE_DENIED/);
  assert.equal(count.auth,0);
});
test('rejects expired DUO session without loading original rider',async()=>{
  const {config,count}=fixture({validateDuo:async()=>({accountId:user,approved:true,expiresAt:t-1})});
  await assert.rejects(createDuoRiderResolver(config)('x','인성1'),/DUO_SESSION_DENIED/);
  assert.equal(count.map,0);
});
test('fails closed if DUO session validator throws',async()=>{
  const {config,count}=fixture({validateDuo:async()=>{throw Error('network secret text')}});
  await assert.rejects(createDuoRiderResolver(config)('x','인성1'),/DUO_SESSION_DENIED/);
  assert.equal(count.map,0);
});
test('rejects missing, expired and unverified user bindings',async()=>{
  const cases=[
    null,{}, {...bound,enabled:false}, {...bound,operatorVerifiedSameMember:false},
    {...bound,duoAccountId:'someone-else'},
    {...bound,sources:['인성2']},
    {...bound,validUntil:new Date(t-1000).toISOString()},
    {...bound,sourceRiderId:'x'.repeat(200)}
  ];
  for(const candidate of cases){
    const {config,count}=fixture({loadMapping:async()=>candidate});
    await assert.rejects(createDuoRiderResolver(config)('x','인성1'),/MAPPING_DENIED/);
    assert.equal(count.rider,0);
  }
});
test('rejects wrong rider or inactive original ZAPGO membership',async()=>{
  const badRider=fixture({loadRider:async()=>({id:'different'})});
  await assert.rejects(createDuoRiderResolver(badRider.config)('x','인성1'),/RIDER_DENIED/);
  const noMembership=fixture({allowRider:async()=>false});
  await assert.rejects(createDuoRiderResolver(noMembership.config)('x','인성1'),/RIDER_MEMBERSHIP_DENIED/);
});
test('database errors fail closed without leaking upstream error details',async()=>{
  const {config}=fixture({loadMapping:async()=>{throw Error('database password secret')}});
  await assert.rejects(createDuoRiderResolver(config)('x','인성1'),e=>{
    assert.equal(e.message,'MAPPING_UNAVAILABLE');
    return true;
  });
});
