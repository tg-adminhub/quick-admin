import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createProtectedAdminClient} from './secure-admin-client.mjs';
import {createSyntheticTransport} from './synthetic-transport.mjs';

let seq=0;
const randomUUID=()=>{
  seq++;
  return 'aaaaaaaa-aaaa-4aaa-8aaa-'+String(seq).padStart(12,'0');
};
function fresh(){
  const transport=createSyntheticTransport({randomUUID});
  assert.equal(transport.syntheticOnly,true);
  const client=createProtectedAdminClient(transport);
  return {transport,client};
}
test('synthetic pilot identity is clearly a fabricated non-production admin',async()=>{
  const {client}=fresh();
  const admin=await client.getIdentity();
  assert.equal(admin.role,'dev');
  assert.equal(admin.id,999);
  assert.match(admin.username,/demo/);
});
test('synthetic row projection cannot reveal internal mock state',async()=>{
  const {client}=fresh();
  const members=await client.getList('members');
  assert.equal(members.length,2);
  assert.equal(members[0].status,'pending');
  assert.equal(members[0].paused,undefined);
  assert.equal(members[0].mainBound,undefined);
  assert.equal(Object.isFrozen(members),true);
  assert.equal(Object.isFrozen(members[0]),true);
  const p=await client.getList('payments');
  assert.equal(p[0].status,'pending');
  assert.equal((await client.getList('branches'))[0].name,'가상 지점');
});
test('approval changes only in-memory mock data',async()=>{
  const {transport,client}=fresh();
  assert.equal((await client.submit(client.prepare('approveMember',101))).outcome,'updated');
  assert.equal((await client.getList('members')).find(x=>x.id===101).status,'approved');
  assert.equal(transport.messages.length,1);
  assert.equal(transport.messages[0].synthetic,true);
});
test('mock rejects state conflicts and duplicate calls are idempotent',async()=>{
  const {client}=fresh();
  const i=client.prepare('approveMember',101);
  assert.equal((await client.submit(i)).outcome,'updated');
  assert.equal((await client.submit(i)).outcome,'duplicate');
  await assert.rejects(
    client.submit(client.prepare('rejectMember',101,{reason:'demo'})),
    e=>e.code==='GATEWAY_UNAVAILABLE'&&e.status===409
  );
});
test('mock supports limited pause/resume and device reset, without network',async()=>{
  const {client}=fresh();
  assert.equal((await client.submit(client.prepare('pauseMember',102))).outcome,'updated');
  assert.equal((await client.submit(client.prepare('resumeMember',102))).outcome,'updated');
  assert.equal((await client.submit(client.prepare('resetMainDevice',102))).outcome,'updated');
  await assert.rejects(
    client.submit(client.prepare('resetMainDevice',102)),
    e=>e.code==='GATEWAY_UNAVAILABLE'
  );
});
test('mock supports ordinary payment rejection without external payment system',async()=>{
  const {client}=fresh();
  const i=client.prepare('rejectPayment',201,{reason:'mock only'});
  assert.equal((await client.submit(i)).outcome,'updated');
  assert.equal((await client.getList('payments'))[0].status,'rejected');
});
test('a newly constructed synthetic transport restores fabricated records',async()=>{
  const first=fresh().client;
  await first.submit(first.prepare('approvePayment',201,{approvedAmount:35000}));
  assert.equal((await first.getList('payments'))[0].status,'approved');
  const newInstance=fresh().client;
  assert.equal((await newInstance.getList('payments'))[0].status,'pending');
});
test('pilot page clearly warns that it is not connected to production',()=>{
  const html=readFileSync(new URL('./secure-pilot.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('./secure-pilot.mjs',import.meta.url),'utf8');
  const transport=readFileSync(new URL('./synthetic-transport.mjs',import.meta.url),'utf8');
  assert.match(html,/가상 데이터 · 운영 DB 미연결/);
  assert.match(html,/실제 Supabase로 네트워크 요청을 보내지 않으며/);
  assert.match(html,/secure-pilot.mjs/);
  assert.match(script,/synthetic-transport.mjs/);
  assert.doesNotMatch(script,/\.from\(/);
  assert.doesNotMatch(script,/\.innerHTML\s*=/);
  assert.doesNotMatch(script,/\bfetch\s*\(/);
  assert.doesNotMatch(transport,/\bfetch\s*\(/);
});
