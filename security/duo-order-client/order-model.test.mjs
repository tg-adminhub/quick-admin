import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOrderState,renderToDuoUI} from './order-model.mjs';

const BASE=Date.parse('2026-11-04T00:00:00Z');
const sample=(id,source='인성1')=>({
  id,source,receivedAt:new Date(BASE-1000).toISOString(),
  from:'백석동',to:'종로구',vehicle:'오토바이',priceKrw:null,distanceKm:2.4
});
const sourceStatuses=[
  {source:'인성1',receiving:true},
  {source:'인성2',receiving:false}
];
test('310-derived source order maps to existing DuoUI expected channel and never invents price',()=>{
  const m=createOrderState({now:()=>BASE});
  const state=m.apply({kind:'orders',source:'인성1',upsert:[sample('285690700')],catchEnabled:false});
  assert.equal(state.orders.length,1);
  assert.equal(state.orders[0].id,'insung1:285690700');
  assert.equal(state.orders[0].sourceOrderId,'285690700');
  assert.equal(state.orders[0].channel,'insung1');
  assert.equal(state.orders[0].priceKrw,null);
  assert.equal(state.orders[0].from,'백석동');
});
test('same source repeated upsert de-duplicates, opposite sources never collide',()=>{
  const m=createOrderState({now:()=>BASE});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('99')],catchEnabled:false});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('99')],catchEnabled:false});
  assert.equal(m.get().orders.length,1);
  m.apply({kind:'orders',source:'인성2',upsert:[sample('99','인성2')],catchEnabled:false});
  assert.equal(m.get().orders.length,2);
  assert.deepEqual(new Set(m.get().orders.map(x=>x.channel)),new Set(['insung1','insung2']));
});
test('incomplete source snapshots do not delete orders on empty heartbeat',()=>{
  const m=createOrderState({now:()=>BASE});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('102')],catchEnabled:false});
  const s=m.apply({kind:'snapshot',orders:[],sources:sourceStatuses,
    sourceSnapshotComplete:false,dualAllowed:true,catchEnabled:false});
  assert.equal(s.orders.length,1);
  assert.equal(s.dualAllowed,true);
  assert.equal(s.sources[0].receiving,true);
  assert.equal(s.sources[1].receiving,false);
});
test('complete snapshot is allowed to replace state, no invented orders',()=>{
  const m=createOrderState({now:()=>BASE});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('102')],catchEnabled:false});
  const s=m.apply({kind:'snapshot',orders:[],sources:sourceStatuses,
    sourceSnapshotComplete:true,dualAllowed:true,catchEnabled:false});
  assert.equal(s.orders.length,0);
});
test('complete snapshot with both sources filters and maps items',()=>{
  const m=createOrderState({now:()=>BASE});
  const s=m.apply({kind:'snapshot',orders:[sample('1'),sample('2','인성2')],
    sources:[{source:'인성1',receiving:true},{source:'인성2',receiving:true}],
    sourceSnapshotComplete:true,dualAllowed:false,catchEnabled:false});
  assert.equal(s.orders.length,2);
  assert.deepEqual(new Set(s.orders.map(o=>o.channel)),new Set(['insung1','insung2']));
  assert.equal(s.dualAllowed,false);
});
test('stale orders disappear without claiming live receipt',()=>{
  let t=BASE;const m=createOrderState({now:()=>t});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('3')],catchEnabled:false});
  t+=70000;
  assert.equal(m.get().orders.length,0);
});
test('revoked session clears orders and both LIVE flags',()=>{
  const m=createOrderState({now:()=>BASE});
  m.apply({kind:'orders',source:'인성1',upsert:[sample('4')],catchEnabled:false});
  m.apply({kind:'snapshot',orders:[],sources:sourceStatuses,
    sourceSnapshotComplete:false,dualAllowed:true,catchEnabled:false});
  const r=m.revoke();
  assert.equal(r.orders.length,0);
  assert.equal(r.blocked,true);
  assert.equal(r.dualAllowed,false);
  assert.ok(r.sources.every(s=>s.receiving===false));
  assert.equal(m.reset().blocked,false);
});
test('unknown sources, catch-enabled data and malformed payload fail closed',()=>{
  const m=createOrderState({now:()=>BASE});
  assert.throws(()=>m.apply({kind:'orders',source:'Other',upsert:[]}),/UNRECOGNIZED_SOURCE/);
  assert.throws(()=>m.apply({kind:'orders',source:'인성1',upsert:[sample('9')],catchEnabled:true}),/UNAPPROVED_CATCH_EVENT/);
  assert.throws(()=>m.apply({kind:'orders',source:'인성1',upsert:null}),/ORDER_EVENT_INVALID/);
  assert.throws(()=>m.apply({kind:'evil',upsert:[]}),/NOT_ALLOWED/);
  assert.equal(m.get().orders.length,0);
});
test('malformed or future-dated orders cannot display fake fare or unsafe ID',()=>{
  const m=createOrderState({now:()=>BASE});
  const invalid=[{...sample('1'),id:'<img>'},{...sample('2'),receivedAt:'not-a-date'},
    {...sample('3'),receivedAt:new Date(BASE+90000).toISOString()}];
  m.apply({kind:'orders',source:'인성1',upsert:invalid});
  assert.equal(m.get().orders.length,0);
  m.apply({kind:'orders',source:'인성1',upsert:[{...sample('ok'),priceKrw:-200}]});
  assert.equal(m.get().orders[0].priceKrw,null);
});
test('UI bridge renders existing setSnapshot, setStatus A/B, setDualAllowed only',()=>{
  const calls=[];
  const ui={
    setSnapshot(v){calls.push(['snapshot',v]);},
    setStatus(s,v){calls.push(['status',s,v]);},
    setDualAllowed(v){calls.push(['dual',v]);},
    pushOrder(){throw Error('CATCH_MUST_NOT_RUN');},
    showDispatch(){throw Error('CATCH_MUST_NOT_RUN')}
  };
  const m=createOrderState({now:()=>BASE});
  const data=m.apply({kind:'snapshot',orders:[sample('1')],sources:sourceStatuses,
    dualAllowed:true,sourceSnapshotComplete:false,catchEnabled:false});
  renderToDuoUI(ui,data);
  assert.equal(calls[0][1].orders[0].channel,'insung1');
  assert.deepEqual(calls[1],['status','A',{live:true}]);
  assert.deepEqual(calls[2],['status','B',{live:false}]);
  assert.deepEqual(calls[3],['dual',true]);
  renderToDuoUI(ui,m.revoke());
  assert.equal(calls.at(-4)[1].orders.length,0);
});
