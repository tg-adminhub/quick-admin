import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSseDecoder,createOrderStreamClient} from './sse-client.mjs';
import {createOrderState} from './order-model.mjs';

const TEST_URL='https://receiver.example/duo/live/events';
const TOKEN='aaa.bbb.ccc';
const BASE=Date.parse('2026-11-04T00:00:00Z');
const order={id:'285690700',receivedAt:new Date(BASE-1000).toISOString(),
  from:'백석동',to:'종로구',priceKrw:null};
const event=(o)=>'data: '+JSON.stringify(o)+'\n\n';
const bytes=new TextEncoder();
test('SSE decoder handles fragmented HTTP chunks and : heartbeat',()=>{
  const results=[],d=createSseDecoder(value=>results.push(value));
  const line=': ping\n'+event({kind:'orders',source:'인성1',upsert:[order],catchEnabled:false});
  const encoded=bytes.encode(line);
  d.push(encoded.slice(0,7));
  d.push(encoded.slice(7,29));
  d.push(encoded.slice(29));
  d.finish();
  assert.equal(results.length,1);
  assert.equal(results[0].upsert[0].id,'285690700');
});
test('multi-line SSE data is assembled with newline before JSON parse',()=>{
  const out=[],d=createSseDecoder(e=>out.push(e));
  d.push(bytes.encode('data: {"kind":"snapshot",\ndata: "orders":[]}\n\n'));
  d.finish();
  assert.equal(out[0].kind,'snapshot');
});
test('incomplete SSE event does not invent an order on stream end',()=>{
  const out=[],d=createSseDecoder(e=>out.push(e));
  d.push(bytes.encode('data: {"kind":"orders","source":"인성1"}'));
  d.finish();
  assert.deepEqual(out,[]);
});
test('SSE parser refuses malformed or oversized JSON',()=>{
  const d=createSseDecoder(()=>{});
  assert.throws(()=>d.push(bytes.encode('data: not-json\n\n')),/SSE_JSON_INVALID/);
  const d2=createSseDecoder(()=>{});
  assert.throws(()=>d2.push(bytes.encode('data: '+('x'.repeat(68000))+'\n\n')),/SSE_BUFFER_OVERFLOW|SSE_EVENT_TOO_LARGE/);
});
test('stream sends member JWT in header only, maps order, clears on disconnect',async()=>{
  const observed=[],headers=[],calls=[];
  const model=createOrderState({now:()=>BASE});
  const stream=bytes.encode(event({kind:'snapshot',orders:[],
      sources:[{source:'인성1',receiving:true}],dualAllowed:true,sourceSnapshotComplete:false,catchEnabled:false})
    +event({kind:'orders',source:'인성1',upsert:[order],catchEnabled:false}));
  const fetchImpl=async (url,opts)=>{
    headers.push(opts.headers);calls.push(url);
    return new Response(new ReadableStream({
      start(c){c.enqueue(stream.slice(0,19));c.enqueue(stream.slice(19));c.close();}
    }),{status:200,headers:{'content-type':'text/event-stream; charset=utf-8'}});
  };
  const client=createOrderStreamClient({
    streamUrl:TEST_URL,getAccessToken:async()=>TOKEN,fetchImpl,model,onState:s=>observed.push(s)
  });
  await assert.rejects(client.start(),/ORDER_STREAM_DISCONNECTED/);
  assert.equal(calls[0],TEST_URL);
  assert.equal(headers[0].Authorization,'Bearer '+TOKEN);
  assert.equal(headers[0].Accept,'text/event-stream');
  assert.equal(calls[0].includes(TOKEN),false);
  assert.ok(observed.some(s=>s.orders.some(o=>o.id==='insung1:285690700')));
  assert.equal(observed.at(-1).orders.length,0);
  assert.equal(observed.at(-1).blocked,true);
});
test('missing/invalid member session never sends a request',async()=>{
  let calls=0;
  for(const value of [null,'invalid','tokeninurl','aa.bb']){
    const client=createOrderStreamClient({streamUrl:TEST_URL,
      getAccessToken:async()=>value,
      fetchImpl:async()=>{calls++;throw Error('MUST_NOT_CALL');}
    });
    await assert.rejects(client.start(),/ORDER_STREAM_AUTH_MISSING/);
    assert.equal(client.state.orders.length,0);
  }
  assert.equal(calls,0);
});
test('HTTP 401/403 revoke any display state and stop retry loop',async()=>{
  for(const status of [401,403]){
    const model=createOrderState({now:()=>BASE});
    const observed=[];
    const client=createOrderStreamClient({streamUrl:TEST_URL,
      getAccessToken:async()=>TOKEN,
      fetchImpl:async()=>new Response('unauthorized',{status}),
      model,onState:s=>observed.push(s)
    });
    await assert.rejects(client.start(),/ORDER_STREAM_ACCESS_DENIED/);
    assert.equal(observed.at(-1).blocked,true);
  }
});
test('wrong content type and network failure never claim order receipt',async()=>{
  const clients=[
    createOrderStreamClient({streamUrl:TEST_URL,getAccessToken:async()=>TOKEN,
      fetchImpl:async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}})}),
    createOrderStreamClient({streamUrl:TEST_URL,getAccessToken:async()=>TOKEN,
      fetchImpl:async()=>{throw Error('network failed');}})
  ];
  for(const client of clients){
    await assert.rejects(client.start());
    assert.equal(client.state.blocked,true);
    assert.equal(client.state.orders.length,0);
  }
});
test('HTTPS fixed route only: no token in URL, insecure transport or arbitrary path',()=>{
  for(const u of [
    'http://receiver.example/duo/live/events',
    'https://receiver.example/duo/live/events?token=secret',
    'https://receiver.example/duo/live/events#jwt',
    'https://receiver.example/health',
    'https://u:p@receiver.example/duo/live/events',
    'https://127.0.0.1/duo/live/events',
    'https://localhost/duo/live/events'
  ])assert.throws(()=>createOrderStreamClient({streamUrl:u,getAccessToken:async()=>TOKEN}),/STREAM_URL_INVALID/);
});
test('cannot open two concurrent streams under one client',async()=>{
  let release;
  const waiting=new Promise(ok=>release=ok);
  const fetchImpl=async()=>{await waiting;return new Response(null,{status:503})};
  const client=createOrderStreamClient({streamUrl:TEST_URL,getAccessToken:async()=>TOKEN,fetchImpl});
  const active=client.start();
  await assert.rejects(client.start(),/ORDER_STREAM_ALREADY_ACTIVE/);
  release();
  await assert.rejects(active);
});
