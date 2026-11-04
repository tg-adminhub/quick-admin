# DUO post-login order receive integration — development only

**This code is not inside the currently published DUO APK.** The published development APK 1.0.01 contains `window.DuoUI`, `setSnapshot`, `setStatus`, both Insung labels, and DUO login/status endpoints, but a read-only ZIP/DEX scan did not find `/duo/live/events`, `duo-stream-authorize`, or SSE stream client markers. Absence of static strings is not definitive evidence of missing native functionality; a real authenticated phone test is still needed.

## Existing approved receive server data contract

Based on the independently tested service `/opt/duo-independent-receive/src/service.mjs`: upstream vendor-authenticated packets `subType=310` are parsed and delivered through a loopback-only `GET /duo/live/events` Server-Sent Events endpoint. The receiver emits `snapshot` with `orders`, `sources`, `dualAllowed` and `sourceSnapshotComplete:false`, and `orders` events with `source:'인성1'|'인성2'`, `upsert`, and `catchEnabled:false`.

`order-model.mjs` converts that data to the existing WebView `window.DuoUI.setSnapshot({orders:[...]})`, with `channel:'insung1'|'insung2'`. It updates `DuoUI.setStatus('A'|'B',{live})` and `DuoUI.setDualAllowed()`. It deduplicates within a channel, prevents cross-channel ID collisions, never fabricates a price, and honors non-authoritative (`sourceSnapshotComplete:false`) snapshots. It only displays orders, not accepts or dispatches them.

`sse-client.mjs` is a single-session authenticated SSE reader using `fetch` with an Authorization header (no tokens in URL/query). It requires an HTTPS URL ending in `/duo/live/events`, refuses loopback and insecure URLs for phone use, enforces size limits, and clears local order state on authorization loss or disconnect. The endpoint URL is deliberately **NOT** configured until a trusted TLS proxy and independent receiver exist.

## Integration sketch (NOT for immediate production)

After a legitimate approved DUO login, retain the actual DUO JWT in the existing secure session mechanism. Only after the main WebView has loaded `assets/duo-main.html` and `window.DuoUI` is available, a native Android network adapter (recommended: existing OkHttp) or a secure WebView fetch transport may connect to the trusted TLS endpoint with the header `Authorization: Bearer <DUO-JWT>`.

Pass each decoded SSE JSON event to `orderState.apply(event)`, then call `renderToDuoUI(window.DuoUI,orderState.get())` on the main/UI thread. On logout, license expiry, admin revocation, or app shutdown, cancel the stream and clear the UI. If the transport unexpectedly closes, clear LIVE flags and reconnect only through bounded, authorized retry logic. Do NOT use browser EventSource, since it cannot attach this Authorization header. Do NOT use fake upstream device IDs or bypass the Insung device-approval process.

### Structural code example for an Android-supported JS context

```js
import {createOrderState,renderToDuoUI} from './order-model.mjs';
import {createOrderStreamClient} from './sse-client.mjs';
const state=createOrderState();
const stream=createOrderStreamClient({
  streamUrl: VERIFIED_TLS_RECEIVER_URL,
  getAccessToken: async () => CURRENT_DUO_AUTH_JWT,
  onState: eventState => renderToDuoUI(window.DuoUI,eventState)
});
// Start only after approved login AND UI initialization:
// await stream.start();
// On logout: stream.stop();
```

This is a contract example, **not** an APK patch. The actual app's Java source and WebView lifecycle hooks are required to wire this in. File-origin WebView pages often need a native network transport to avoid CORS or leaking session tokens.

## Remaining hard prerequisites

1. The approved independent vendor source module `/etc/duo-independent/vendor-approved-login.mjs` and official device profiles were **missing** at the last Vultr audit; the actual receiver was not activated. Do not claim any live Insung order receipt or start a service with fabricated credentials.
2. The receiver binds to `127.0.0.1:18320` by default. An Android phone cannot reach the VPS loopback address. A dedicated authenticated TLS gateway/proxy must be provisioned and independently validated; do not expose 18320 on public interfaces.
3. Obtain the actual Android source project from the user's Windows machine (`C:\zzgi\Duo\duo test 2`) to modify and rebuild a new signed APK; this GitHub repo contains the admin website, not the complete DUO Android app source.
4. Test with dummy 310 events and permission revocation before running a real vendor-approved Insung session.
5. Verify screen display, two-channel order timing, reconnect behavior, and UI state after actual logged-in app launch. Do not confuse mocked order events with live receipts.

## Tests

```bash
node --test security/duo-order-client/order-model.test.mjs security/duo-order-client/sse-client.test.mjs
```

Security branch only; never merge PR #2 or deploy the receiver before all above prerequisites and tests are satisfied.

## V6 existing-ZAPGO-session integration (2026-11-04)

The user confirms ZAPGO is their own approved app and its authenticated receive session may be reused. Do NOT create new Insung TCP connections or copy vendor device credentials. The previously developed ZAPGO V6 existing-session mirror uses local port **18302** for its SSE/health service, not the separate independent DUO receive port 18320.

- `v6-existing-session-bridge.mjs` adapts V6 SSE `snapshot` and `orders` events into the existing `DuoUI.setSnapshot`, `setStatus` and dual status display methods; it does not send catch/cancel commands.
- DUO authenticates with its *own* member JWT in an Authorization header. Never pass ZAPGO JWT to DUO. Bind only the same verified user using `/etc/duo-receive/bindings.json`.
- V6's original upstream session must be active in ZAPGO for DUO to see new events. Disconnecting ZAPGO's source sessions stops DUO's mirrored order feed; `health` HTTP 200 alone is not proof of receiving fresh orders.
- Before production switch: verify `http://127.0.0.1:18302/health`, confirmed binding, active source sessions, SSE subscription and new order events. This is read-only and requires NO original Gateway restart.
- The Android app cannot access the VPS loopback URL. A reviewed HTTPS proxy to the exact `/duo/live/events` route is required. The published DUO 1.0.01 APK has no proven event-stream client: rebuild after native Android integration.
- Never auto-restart the original sisd-gateway or overwrite ZAPGO's receiver during business hours. Existing sessions must be preserved.

IMPORTANT: the separately staged independent DUO receiver on 18320 needs its own vendor-approved login and device profile, but those are **not prerequisites** for reusing an already authenticated ZAPGO session via the V6 mirror.

GitHub Actions tests the V6 bridge with fabricated SSE frames. The real VPS and published APK are not altered by the commits in this folder.