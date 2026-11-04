/**
 * DUO post-login receive -> WebView display adapter. DEVELOPMENT ONLY.
 * No Insung socket, no catch/dispatch. NEVER simulates successful receiving.
 *
 * Receiver emits:
 *   {kind:'snapshot',orders,sources,dualAllowed,sourceSnapshotComplete:false}
 *   {kind:'orders',source:'인성1'|'인성2',upsert:[...],catchEnabled:false}
 *
 * The existing DuoUI expects channel 'insung1' / 'insung2' and a complete
 * display list via DuoUI.setSnapshot({orders:[...]}). Source snapshots marked
 * incomplete must NOT clear the current order cache.
 */
export const CHANNELS=Object.freeze({'인성1':'insung1','인성2':'insung2'});
const REVERSE=Object.freeze({'insung1':'인성1','insung2':'인성2'});
const MAX_ORDERS=400;
const MAX_FUTURE_MS=30000;
const MAX_AGE_MS=65000;
const ORDER_ID=/^[A-Za-z0-9_-]{1,96}$/;

function normalizeOrder(raw,source,now){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const s=CHANNELS[source]?source:REVERSE[raw.channel]||raw.source;
  if(!CHANNELS[s])return null;
  const id=String(raw.sourceOrderId??raw.id??'');
  if(!ORDER_ID.test(id))return null;
  const parsed=typeof raw.receivedAt==='string'?Date.parse(raw.receivedAt):
    typeof raw.receivedAt==='number'?raw.receivedAt:NaN;
  if(!Number.isFinite(parsed)||parsed<now-MAX_AGE_MS||parsed>now+MAX_FUTURE_MS)return null;
  const str=(v,max=160)=>typeof v==='string'&&v.length<=max?v:'';
  const rawFare=raw.priceKrw;
  const price=Number.isSafeInteger(rawFare)&&rawFare>=0&&rawFare<=50000000?rawFare:null;
  const distance=typeof raw.distanceKm==='number'&&Number.isFinite(raw.distanceKm)&&
    raw.distanceKm>=0&&raw.distanceKm<=10000?raw.distanceKm:null;
  const channel=CHANNELS[s];
  return Object.freeze({
    id:channel+':'+id,sourceOrderId:id,channel,
    from:str(raw.from),to:str(raw.to),kind:str(raw.kind,30),
    vehicle:str(raw.vehicle,60),distanceKm:distance,
    priceKrw:price,receivedAt:new Date(parsed).toISOString()
  });
}
export function createOrderState({now=Date.now,maxOrders=MAX_ORDERS}={}){
  if(typeof now!=='function'||!Number.isInteger(maxOrders)||maxOrders<1||maxOrders>MAX_ORDERS)
    throw Error('ORDER_STATE_CONFIG_INVALID');
  const map=new Map();
  const sourceStatus=new Map([['인성1',false],['인성2',false]]);
  let dualAllowed=false,lastEventAt=null;
  let closed=false,blocked=false;
  const snapshot=()=>{
    const time=now();
    for(const [key,item] of map)
      if(Date.parse(item.receivedAt)<time-MAX_AGE_MS)map.delete(key);
    const orders=[...map.values()]
      .sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt))
      .slice(0,maxOrders);
    return Object.freeze({orders,dualAllowed,blocked,lastEventAt,
      sources:['인성1','인성2'].map(source=>Object.freeze({
        source,receiving:!blocked && sourceStatus.get(source)===true
      }))});
  };
  function upsert(items,source){
    if(!Array.isArray(items)||items.length>MAX_ORDERS)throw Error('ORDER_EVENT_INVALID');
    for(const raw of items){
      const item=normalizeOrder(raw,source,now());
      if(item)map.set(item.id,item);
    }
    if(map.size>maxOrders){
      const ids=[...map.values()].sort((a,b)=>
        Date.parse(b.receivedAt)-Date.parse(a.receivedAt)).slice(0,maxOrders).map(x=>x.id);
      const keep=new Set(ids);
      for(const id of map.keys())if(!keep.has(id))map.delete(id);
    }
  }
  return Object.freeze({
    apply(event){
      if(closed)throw Error('ORDER_STREAM_CLOSED');
      if(!event||typeof event!=='object'||Array.isArray(event))throw Error('ORDER_EVENT_INVALID');
      if(event.catchEnabled===true)throw Error('UNAPPROVED_CATCH_EVENT');
      if(event.kind==='orders'){
        if(!CHANNELS[event.source])throw Error('UNRECOGNIZED_SOURCE');
        upsert(event.upsert,event.source);
      }else if(event.kind==='snapshot'){
        if(!Array.isArray(event.orders)||event.orders.length>MAX_ORDERS)throw Error('ORDER_SNAPSHOT_INVALID');
        if(event.sourceSnapshotComplete===true)map.clear();
        upsert(event.orders,null);
        if(Array.isArray(event.sources)){
          for(const p of event.sources)
            if(p&&CHANNELS[p.source]&&typeof p.receiving==='boolean')
              sourceStatus.set(p.source,p.receiving);
        }
        if(typeof event.dualAllowed==='boolean')dualAllowed=event.dualAllowed;
      }else if(event.kind==='revoked'||event.kind==='logout'){
        map.clear();for(const k of sourceStatus.keys())sourceStatus.set(k,false);
        dualAllowed=false;blocked=true;
      }else{
        throw Error('ORDER_EVENT_KIND_NOT_ALLOWED');
      }
      lastEventAt=now();
      return snapshot();
    },
    get:snapshot,
    revoke(){
      map.clear();for(const k of sourceStatus.keys())sourceStatus.set(k,false);
      dualAllowed=false;blocked=true;lastEventAt=now();return snapshot();
    },
    reset(){
      map.clear();for(const k of sourceStatus.keys())sourceStatus.set(k,false);
      dualAllowed=false;blocked=false;lastEventAt=null;return snapshot();
    },
    close(){
      closed=true;map.clear();for(const k of sourceStatus.keys())sourceStatus.set(k,false);
      dualAllowed=false;blocked=true;
    }
  });
}
export function renderToDuoUI(duoUI,state){
  if(!duoUI||typeof duoUI.setSnapshot!=='function'||typeof duoUI.setStatus!=='function')
    throw Error('DUO_UI_BRIDGE_MISSING');
  if(!state||!Array.isArray(state.orders)||!Array.isArray(state.sources))
    throw Error('DUO_UI_STATE_INVALID');
  // NEVER call pushOrder/showDispatch/catch. Read-only receive/display.
  duoUI.setSnapshot({orders:state.orders});
  for(const pair of [['인성1','A'],['인성2','B']]){
    const status=state.sources.find(x=>x.source===pair[0]);
    duoUI.setStatus(pair[1],{live:!state.blocked&&status?.receiving===true});
  }
  if(typeof duoUI.setDualAllowed==='function')
    duoUI.setDualAllowed(state.dualAllowed===true);
}
