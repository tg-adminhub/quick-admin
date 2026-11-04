/**
 * DUO-only WSS handshake parser for a trusted TLS terminator.
 * Must NOT be attached to the existing ZAPGO ?token= route.
 * No network calls, token signing, or vendor authentication.
 */
export function parseDuoUpgrade({url,authorization,secureTransport}={}){
  if(secureTransport!==true)throw Error('DUO_TLS_REQUIRED');
  if(typeof url!=='string'||url.length>512)throw Error('DUO_ROUTE_INVALID');
  let uri;try{uri=new URL(url,'https://duo.invalid')}catch{throw Error('DUO_ROUTE_INVALID')}
  if(uri.pathname!=='/duo/driver-ws'||uri.hash||uri.username||uri.password||
    uri.searchParams.size!==1||!uri.searchParams.has('port'))
    throw Error('DUO_ROUTE_INVALID');
  const port=uri.searchParams.get('port');
  if(port!=='12000'&&port!=='12200')throw Error('DUO_SOURCE_INVALID');
  if(typeof authorization!=='string'||authorization.length>8200||
    !authorization.startsWith('Bearer '))
    throw Error('DUO_AUTH_REQUIRED');
  const token=authorization.slice(7);
  if(token.length>8192||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    throw Error('DUO_AUTH_REQUIRED');
  return Object.freeze({port:Number(port),source:port==='12000'?'인성1':'인성2',token});
}
