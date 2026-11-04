/**
 * DUO SSE client (development only). One authenticated, read-only connection.
 * No public receiver URL is configured yet; the independent receiver binds to
 * 127.0.0.1 by default. A legitimate TLS proxy and vendor-approved source are
 * prerequisites for any real phone connection.
 *
 * This deliberately avoids EventSource, which cannot send Authorization header.
 * It never sends JWTs in URL/query, localStorage, logs, or UI state.
 */
import {createOrderState} from './order-model.mjs';
const JWT=/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_BUFFER=65536;
function checkUrl(value){
  let u;try{u=new URL(value);}catch{throw Error('STREAM_URL_INVALID');}
  if(u.protocol!=='https:'||u.pathname!=='/duo/live/events'||
    u.search||u.hash||u.username||u.password||u.port||
    !u.hostname||['localhost','127.0.0.1','::1'].includes(u.hostname))
    throw Error('STREAM_URL_INVALID');
  return u.href;
}
function parseDataEvent(text){
  if(text.length>MAX_BUFFER)throw Error('SSE_EVENT_TOO_LARGE');
  let value;
  try{value=JSON.parse(text);}catch{throw Error('SSE_JSON_INVALID');}
  return value;
}
export function createSseDecoder(onEvent){
  if(typeof onEvent!=='function')throw Error('SSE_HANDLER_REQUIRED');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let buf='',parts=[];
  function line(line){
    if(line.endsWith('\r'))line=line.slice(0,-1);
    if(line===''){
      if(parts.length)onEvent(parseDataEvent(parts.join('\n')));
      parts=[];
    }else if(line.startsWith('data:')){
      let p=line.slice(5);
      if(p.startsWith(' '))p=p.slice(1);
      parts.push(p);
      if(parts.join('\n').length>MAX_BUFFER)throw Error('SSE_EVENT_TOO_LARGE');
    }else if(line.startsWith(':')){
      // heartbeat / keepalive
    }else if(line.startsWith('event:')||line.startsWith('id:')||line.startsWith('retry:')){
      // Ignore control fields; the application uses only explicit JSON payloads.
    }
  }
  return Object.freeze({
    push(chunk){
      if(!(chunk instanceof Uint8Array))throw Error('SSE_CHUNK_INVALID');
      buf+=decoder.decode(chunk,{stream:true});
      if(buf.length>MAX_BUFFER)throw Error('SSE_BUFFER_OVERFLOW');
      let at;while((at=buf.indexOf('\n'))>=0){
        line(buf.slice(0,at));buf=buf.slice(at+1);
      }
    },
    finish(){
      buf+=decoder.decode();
      if(buf.trim())line(buf);
      // No blank line means incomplete SSE event: do not invent a partial order.
      buf='';parts=[];
    }
  });
}

export function createOrderStreamClient({
  streamUrl,
  getAccessToken,
  fetchImpl=globalThis.fetch,
  model=createOrderState(),
  onState=()=>{}
}={}){
  const url=checkUrl(streamUrl);
  if(typeof getAccessToken!=='function'||typeof fetchImpl!=='function'||
    typeof onState!=='function'||typeof model.apply!=='function')
    throw Error('ORDER_STREAM_CONFIG_INVALID');
  let abort=null,active=false;
  return Object.freeze({
    async start(){
      if(active)throw Error('ORDER_STREAM_ALREADY_ACTIVE');
      active=true;abort=new AbortController();
      model.reset();
      onState(model.get());
      let token;
      try{token=await getAccessToken();}
      catch{active=false;model.revoke();onState(model.get());throw Error('ORDER_STREAM_AUTH_MISSING');}
      if(typeof token!=='string'||token.length>8192||!JWT.test(token)){
        active=false;model.revoke();onState(model.get());
        throw Error('ORDER_STREAM_AUTH_MISSING');
      }
      if(abort.signal.aborted){active=false;return;}
      try{
        const r=await fetchImpl(url,{
          method:'GET',headers:{
            Authorization:'Bearer '+token,Accept:'text/event-stream'
          },
          credentials:'omit',redirect:'error',cache:'no-store',signal:abort.signal
        });
        if(r.status===401||r.status===403)throw Error('ORDER_STREAM_ACCESS_DENIED');
        if(!r.ok||!r.body)throw Error('ORDER_STREAM_UNAVAILABLE');
        if(!/text\/event-stream/i.test(r.headers.get('content-type')||''))
          throw Error('ORDER_STREAM_WRONG_CONTENT_TYPE');
        const sse=createSseDecoder(event=>{
          const state=model.apply(event);
          onState(state);
        });
        const reader=r.body.getReader();
        try{
          while(true){
            const {done,value}=await reader.read();
            if(done)break;
            if(!active||abort.signal.aborted)break;
            sse.push(value);
          }
          sse.finish();
        }finally{
          await reader.cancel().catch(()=>{});
          reader.releaseLock();
        }
        if(active&&!abort.signal.aborted)throw Error('ORDER_STREAM_DISCONNECTED');
      }catch(e){
        model.revoke();onState(model.get());
        if(!abort.signal.aborted)throw Error(e instanceof Error?e.message:'ORDER_STREAM_UNAVAILABLE');
      }finally{
        active=false;abort=null;
      }
    },
    stop(){
      if(abort)abort.abort();
      active=false;model.revoke();onState(model.get());
    },
    get active(){return active;},
    get state(){return model.get();}
  });
}
