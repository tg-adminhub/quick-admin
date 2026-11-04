/**
 * DUO user -> original rider authorization boundary.
 * Pure integration module; it does not establish vendor connections.
 * Deploy only alongside the reviewed original SISD server.
 */
export function createDuoRiderResolver({validateDuo,loadMapping,loadRider,allowRider,clock=Date.now}={}){
  if([validateDuo,loadMapping,loadRider,allowRider,clock].some(x=>typeof x!=='function'))
    throw Error('DUO_RESOLVER_CONFIG');
  return async function resolve(token,source){
    if(source!=='인성1'&&source!=='인성2')throw Error('SOURCE_DENIED');
    let session;
    try{session=await validateDuo(token)}catch{throw Error('DUO_SESSION_DENIED')}
    if(!session?.approved||!session.accountId||!Number.isFinite(session.expiresAt)||
      session.expiresAt<=clock())throw Error('DUO_SESSION_DENIED');
    let mapping;
    try{mapping=await loadMapping(session.accountId)}catch{throw Error('MAPPING_UNAVAILABLE')}
    const expiry=Date.parse(mapping?.validUntil);
    if(mapping?.duoAccountId!==session.accountId||mapping.enabled!==true||
      mapping.operatorVerifiedSameMember!==true||
      !Array.isArray(mapping.sources)||!mapping.sources.includes(source)||
      !Number.isFinite(expiry)||expiry<=clock()||
      typeof mapping.sourceRiderId!=='string'||mapping.sourceRiderId.length>128)
      throw Error('MAPPING_DENIED');
    let rider;
    try{rider=await loadRider(mapping.sourceRiderId)}catch{throw Error('RIDER_UNAVAILABLE')}
    if(!rider||String(rider.id)!==mapping.sourceRiderId)
      throw Error('RIDER_DENIED');
    let allowed;
    try{allowed=await allowRider(rider)}catch{throw Error('RIDER_MEMBERSHIP_UNAVAILABLE')}
    if(allowed!==true)throw Error('RIDER_MEMBERSHIP_DENIED');
    return Object.freeze({
      accountId:session.accountId,
      source,
      port:source==='인성1'?12000:12200,
      rider,
      expiresAt:Math.min(session.expiresAt,expiry,clock()+15000)
    });
  };
}
