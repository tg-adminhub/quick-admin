/**
 * V6 read-only existing-ZAPGO-session -> DUO display connection.
 * NOT installed in the published APK. No ZAPGO credentials, new TCP socket,
 * vendor login, polling, accept/catch, or cancel calls are made here.
 *
 * Operational source: existing-session V6 mirror on local port 18302 behind
 * an independently reviewed HTTPS reverse proxy. Caller must supply an actual
 * permitted external TLS URL for /duo/live/events and the DUO member JWT.
 */
import {createOrderState,renderToDuoUI} from './order-model.mjs';
import {createOrderStreamClient} from './sse-client.mjs';

export function createV6DuoDisplayBridge({
  duoUI,streamUrl,getAccessToken,fetchImpl,
  now=Date.now,onDiagnostic=()=>{}
}={}){
  if(!duoUI||typeof duoUI.setSnapshot!=='function'||
     typeof duoUI.setStatus!=='function'||
     typeof getAccessToken!=='function'||typeof onDiagnostic!=='function')
    throw Error('DUO_V6_BRIDGE_CONFIG_INVALID');
  const model=createOrderState({now});
  let lastBlocked=null,lastSourceState='',lastOrderCount=-1;
  function show(state){
    // Only the read-only DuoUI public methods are called.
    renderToDuoUI(duoUI,state);
    const sourceStatus=state.sources.map(x=>x.source+':'+(x.receiving?'READY':'WAIT')).join(',');
    if(lastBlocked!==state.blocked||sourceStatus!==lastSourceState||lastOrderCount!==state.orders.length){
      lastBlocked=state.blocked;lastSourceState=sourceStatus;lastOrderCount=state.orders.length;
      onDiagnostic(Object.freeze({
        connected:!state.blocked&&state.sources.some(s=>s.receiving),
        sources:state.sources.map(x=>Object.freeze({...x})),
        blocked:state.blocked,
        receivedOrderCount:state.orders.length
      }));
    }
  }
  const client=createOrderStreamClient({
    streamUrl,getAccessToken,fetchImpl,model,onState:show
  });
  return Object.freeze({
    /**
     * Resolves only when stopped; unexpected disconnects reject and clear UI.
     * Caller may retry with controlled backoff after inspecting the reason.
     */
    start:()=>client.start(),
    stop:()=>client.stop(),
    get active(){return client.active;},
    get state(){return client.state;}
  });
}
