import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createV6DuoDisplayBridge} from './v6-existing-session-bridge.mjs';

const URL='https://verified-receiver.example/duo/live/events';
const TOKEN='a.b.c';
const at=Date.parse('2026-11-04T03:00:00Z');
const receivedAt=new Date(at-1000).toISOString();
const line=o=>'data: '+JSON.stringify(o)+'\n\n';

test('ZAPGO V6 shared receive displays Insung 1 and 2 separately with no extra upstream session',async()=>{
  const trace=[],calls=[],diagnostics=[];
  const ui={
    setSnapshot:o=>trace.push({type:'snapshot',orders:o.orders}),
    setStatus:(side,s)=>trace.push({type:'status',side,value:s}),
    setDualAllowed:d=>trace.push({type:'dual',value:d}),
    pushOrder:()=>{throw Error('DISPATCH_NOT_ALLOWED')},
    showDispatch:()=>{throw Error('DISPATCH_NOT_ALLOWED')}
  };
  const frames=[
    {kind:'snapshot',orders:[],sources:[{source:'인성1',receiving:true},{source:'인성2',receiving:true}],sourceSnapshotComplete:false,dualAllowed:true,catchEnabled:false},
    {kind:'orders',source:'인성1',upsert:[{id:'101',from:'고양',to:'인천',priceKrw:null,receivedAt}],catchEnabled:false},
    {kind:'orders',source:'인성2',upsert:[{id:'101',from:'고양',to:'서울',priceKrw:12000,receivedAt}],catchEnabled:false}
  ];
  const fetchImpl=async(url,options)=>{
    calls.push({url,headers:options.headers,method:options.method});
    const body=new TextEncoder().encode(frames.map(line).join(''));
    return new Response(new ReadableStream({
      start(c){c.enqueue(body.slice(0,35));c.enqueue(body.slice(35));c.close()}
    }),{status:200,headers:{'content-type':'text/event-stream'}});
  };
  const bridge=createV6DuoDisplayBridge({
    duoUI:ui,streamUrl:URL,getAccessToken:async()=>TOKEN,
    fetchImpl,now:()=>at,onDiagnostic:d=>diagnostics.push(d)
  });
  await assert.rejects(bridge.start(),/ORDER_STREAM_DISCONNECTED/);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,URL);
  assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].headers.Authorization,'Bearer '+TOKEN);
  const filled=trace.filter(x=>x.type==='snapshot').find(x=>x.orders.length===2);
  assert.ok(filled);
  assert.deepEqual(new Set(filled.orders.map(o=>o.channel)),new Set(['insung1','insung2']));
  assert.deepEqual(new Set(filled.orders.map(o=>o.id)),new Set(['insung1:101','insung2:101']));
  assert.equal(filled.orders.find(o=>o.channel==='insung1').priceKrw,null);
  assert.ok(diagnostics.some(d=>d.connected===true&&d.receivedOrderCount===2));
  assert.ok(diagnostics.at(-1).blocked);
  assert.equal(bridge.state.orders.length,0);
});

test('invalid or missing DUO JWT blocks stream without calling ZAPGO',async()=>{
  const ui={setSnapshot(){},setStatus(){}};
  let network=0;
  const bridge=createV6DuoDisplayBridge({
    duoUI:ui,streamUrl:URL,getAccessToken:async()=>null,
    fetchImpl:async()=>{network++;throw Error('MUST_NOT_RUN')}
  });
  await assert.rejects(bridge.start(),/ORDER_STREAM_AUTH_MISSING/);
  assert.equal(network,0);
  assert.equal(bridge.state.blocked,true);
});

test('logout removes all orders and both live statuses; no catch calls',async()=>{
  const states=[];
  const ui={
    setSnapshot:s=>states.push({kind:'snapshot',orders:s.orders}),
    setStatus:(side,v)=>states.push({kind:'status',side,live:v.live}),
    setDualAllowed:()=>{}
  };
  const transport=async(_url,options)=>{
    return new Response(new ReadableStream({
      start(c){
        c.enqueue(new TextEncoder().encode(line({
          kind:'snapshot',sourceSnapshotComplete:false,
          orders:[{id:'222',source:'인성1',receivedAt}],
          sources:[{source:'인성1',receiving:true}],
          dualAllowed:false,catchEnabled:false
        })));
        options.signal.addEventListener('abort',()=>c.close(),{once:true});
      },
      cancel(){}
    }),{status:200,headers:{'content-type':'text/event-stream'}});
  };
  const bridge=createV6DuoDisplayBridge({duoUI:ui,streamUrl:URL,
    getAccessToken:async()=>TOKEN,fetchImpl:transport,now:()=>at});
  const promise=bridge.start().catch(()=>{});
  await new Promise(r=>setTimeout(r,30));
  assert.equal(bridge.state.orders.length,1);
  bridge.stop();
  await promise;
  assert.equal(bridge.state.orders.length,0);
  assert.ok(states.some(s=>s.kind==='status'&&s.side==='A'&&s.live===false));
  assert.ok(states.some(s=>s.kind==='status'&&s.side==='B'&&s.live===false));
});

test('cannot use plain HTTP, local receiver port or access-token URL in Android transport',()=>{
  const ui={setSnapshot(){},setStatus(){}};
  for(const url of [
    'http://127.0.0.1:18302/duo/live/events',
    'http://example.com/duo/live/events',
    'https://receiver.example/duo/live/events?token=secret',
    'https://receiver.example/other'
  ])assert.throws(()=>createV6DuoDisplayBridge({duoUI:ui,
    streamUrl:url,getAccessToken:async()=>TOKEN}),/STREAM_URL_INVALID/);
});
