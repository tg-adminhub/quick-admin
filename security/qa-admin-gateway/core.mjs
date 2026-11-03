/**
 * QUICK ADMIN server-verified admin identity gate (development only).
 * No production deployment, no legacy password fallback, no browser adminId trust.
 *
 * Dependencies are injected for isolated Node tests. Edge runtime supplies:
 * - verifyBearer: verifies a Supabase Auth JWT on the server
 * - loadAdmin: reads a protected, service-role-only RPC by verified Auth user ID
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const ROLES = new Set(['dev', 'master', 'branch', 'sub']);
export const ALLOWED_ORIGIN = 'https://tg-adminhub.github.io';

function headers(origin, allowedOrigin) {
  const h = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin'
  };
  if (origin === allowedOrigin) h['Access-Control-Allow-Origin'] = allowedOrigin;
  return h;
}
function reply(status, payload, origin, allowedOrigin) {
  return new Response(JSON.stringify(payload), {
    status, headers: {'Content-Type': 'application/json; charset=utf-8', ...headers(origin, allowedOrigin)}
  });
}
export function verifiedProfile(value) {
  if (!value || typeof value !== 'object' || value.enabled !== true) return null;
  if (!Number.isSafeInteger(value.adminId) || value.adminId < 1) return null;
  if (!ROLES.has(value.role)) return null;
  if (typeof value.username !== 'string' || !value.username || value.username.length > 128) return null;
  if (typeof value.displayName !== 'string' || !value.displayName || value.displayName.length > 128) return null;
  if (value.role === 'dev') {
    if (value.visibleBranchIds !== null) return null;
    return {
      id: value.adminId, username: value.username, name: value.displayName,
      role: value.role, branchId: Number.isSafeInteger(value.branchId) ? value.branchId : null,
      visibleBranchIds: null
    };
  }
  if (!Number.isSafeInteger(value.branchId) || value.branchId < 1) return null;
  if (!Array.isArray(value.visibleBranchIds) || !value.visibleBranchIds.length) return null;
  if (value.visibleBranchIds.length > 5000) return null;
  if (value.visibleBranchIds.some(x => !Number.isSafeInteger(x) || x < 1)) return null;
  if (!value.visibleBranchIds.includes(value.branchId)) return null;
  return {
    id: value.adminId, username: value.username, name: value.displayName,
    role: value.role, branchId: value.branchId,
    visibleBranchIds: [...new Set(value.visibleBranchIds)].sort((a,b)=>a-b)
  };
}

export async function handleAdminGateway(req, {verifyBearer, loadAdmin, allowedOrigin=ALLOWED_ORIGIN}={}) {
  if (typeof verifyBearer !== 'function' || typeof loadAdmin !== 'function') {
    throw Error('GATEWAY_DEPENDENCIES_MISSING');
  }
  const origin = req.headers.get('origin');
  // CORS is not authentication. It only limits the browser origins allowed to call this endpoint.
  if (origin !== null && origin !== allowedOrigin) {
    return reply(403, {ok:false,code:'ORIGIN_DENIED'}, origin, allowedOrigin);
  }
  const pathname = new URL(req.url).pathname;
  if (!/\/qa-admin-gateway(?:\/me)?\/?$/.test(pathname)) {
    return reply(404, {ok:false,code:'NOT_FOUND'}, origin, allowedOrigin);
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, {status:204,headers:{
      ...headers(origin, allowedOrigin),
      'Access-Control-Allow-Methods':'GET, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type',
      'Access-Control-Max-Age':'600'
    }});
  }
  if (req.method !== 'GET') {
    return reply(405, {ok:false,code:'METHOD_NOT_ALLOWED'}, origin, allowedOrigin);
  }
  if (new URL(req.url).search || req.headers.get('cookie')) {
    return reply(400, {ok:false,code:'REQUEST_NOT_ALLOWED'}, origin, allowedOrigin);
  }
  const bearer = req.headers.get('authorization') || '';
  if (bearer.length > 8200) {
    return reply(401, {ok:false,code:'INVALID_SESSION'}, origin, allowedOrigin);
  }
  const token = TOKEN.exec(bearer)?.[1];
  if (!token || token.length > 8192) {
    return reply(401, {ok:false,code:'INVALID_SESSION'}, origin, allowedOrigin);
  }

  let userId;
  try { userId = await verifyBearer(token); }
  catch { return reply(503, {ok:false,code:'AUTH_UNAVAILABLE'}, origin, allowedOrigin); }
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    return reply(401, {ok:false,code:'INVALID_SESSION'}, origin, allowedOrigin);
  }

  let rawProfile;
  try { rawProfile = await loadAdmin(userId); }
  catch { return reply(503, {ok:false,code:'ACCESS_UNAVAILABLE'}, origin, allowedOrigin); }
  const admin = verifiedProfile(rawProfile);
  if (!admin) return reply(403, {ok:false,code:'ADMIN_ACCESS_DENIED'}, origin, allowedOrigin);

  return reply(200, {ok:true,admin}, origin, allowedOrigin);
}
