import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDuoUpgrade} from './duo-upgrade-route.mjs';
const token='abc.def.ghi';
const sourceForPort=p=>({12000:'인성1',12200:'인성2'})[p];
const build=args=>build({...args,sourceForPort});
test('DUO-only secure route accepts two supported Insung ports and bearer authorization',()=>{
  for(const [port,source] of [['12000','인성1'],['12200','인성2']]){
    const request=build({url:'/duo/driver-ws?port='+port,authorization:'Bearer '+token,secureTransport:true});
    assert.equal(request.port,Number(port));
    assert.equal(request.source,source);
    assert.equal(request.token,token);
  }
});
test('rejects insecure, unknown or query-string credential routes',()=>{
  for(const url of [
    '/duo/driver-ws?port=12000&token=abc.def.ghi',
    '/duo/driver-ws?port=12000#unsafe',
    '/duo/driver-ws?port=12001',
    '/duo/driver-ws?port=12200&port=12000',
    '/duo/driver-ws?token=abc.def.ghi',
    '/duo/driver-ws',
    '/other?port=12000'
  ])assert.throws(()=>build({url,authorization:'Bearer '+token,secureTransport:true}));
  assert.throws(()=>build({url:'/duo/driver-ws?port=12000',authorization:'Bearer '+token,secureTransport:false}),/TLS_REQUIRED/);
});
test('missing or invalid bearer never authenticates',()=>{
  for(const authorization of ['', 'Basic abc', 'Bearer ', 'Bearer x.y', 'Bearer '+('a'.repeat(9000))])
    assert.throws(()=>build({url:'/duo/driver-ws?port=12000',authorization,secureTransport:true}),/AUTH_REQUIRED/);
});

test('source label always comes from live Gateway port mapping, not guessed',()=>{
  const swapped=parseDuoUpgrade({
    url:'/duo/driver-ws?port=12000',authorization:'Bearer '+token,secureTransport:true,
    sourceForPort:port=>port===12000?'인성2':'인성1'
  });
  assert.equal(swapped.source,'인성2');
  assert.throws(()=>parseDuoUpgrade({
    url:'/duo/driver-ws?port=12000',authorization:'Bearer '+token,secureTransport:true
  }),/SOURCE_MAPPING_REQUIRED/);
});
