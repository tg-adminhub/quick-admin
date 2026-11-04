#!/usr/bin/env python3
"""Read-only APK inspection of the SHA-verified *published development build*.
Does NOT authenticate, patch, decompile, or send Insung requests.
"""
import os
import sys
import zipfile
from pathlib import Path

p = Path(os.environ.get('DUO_APK_PATH', ''))
if not p.is_file():
    raise SystemExit('APK_NOT_PRESENT')

markers = {
    'DUO_LOGIN_ENDPOINT': b'duo-member-login',
    'DUO_STATUS_ENDPOINT': b'duo-my-status',
    'DUO_STREAM_AUTH_ENDPOINT': b'duo-stream-authorize',
    'DUO_ORDER_SSE_ROUTE': b'/duo/live/events',
    'DUO_UI_BRIDGE': b'window.DuoUI',
    'DUO_UI_SNAPSHOT': b'setSnapshot(',
    'DUO_UI_STATUS': b'setStatus(',
    'EVENTSOURCE': b'EventSource',
    'FETCH_STREAM': b'getReader',
    'ORDER_EVENT_KIND': b'kind',
    'ORDER_UPSERT': b'upsert',
    'AUTH_BEARER': b'Bearer ',
    'INSUNG_SOURCE_ONE': '인성1'.encode('utf-8'),
    'INSUNG_SOURCE_TWO': '인성2'.encode('utf-8'),
}
results = {k:[] for k in markers}
assets=[]
with zipfile.ZipFile(p, 'r') as apk:
    for z in apk.infolist():
        name=z.filename
        if name.endswith('/'): continue
        if name.startswith('assets/') and (name.endswith(('.html','.js','.json','.mjs'))):
            assets.append(name)
        if z.file_size > 6_000_000 or z.compress_size > 6_000_000: continue
        if not (name.startswith('assets/') or name.endswith('.dex')): continue
        if not (name.endswith(('.html','.js','.json','.mjs','.dex'))): continue
        blob=apk.read(name)
        for k,m in markers.items():
            if m in blob: results[k].append(name)

print('=== DUO PUBLISHED APK ORDER WIRING INVENTORY ===')
print('APK_TOTAL_ASSETS:',len(assets))
print('ASSET_HTML_JS:',','.join(sorted(assets)[:20]) or 'NONE')
for k,v in results.items():
    # Report booleans, not URL/token fragments or other private app contents.
    print(k+':', 'FOUND' if v else 'NOT_FOUND', 'COUNT_'+str(len(v)))
stream = bool(results['DUO_ORDER_SSE_ROUTE'])
print('EXACT_SSE_PATH_PRESENT:', 'YES' if stream else 'NO')
print('LIMITATION: NOT_FOUND is not proof of no receiver, obfuscated/dynamically built strings may exist')
print('LIMITATION: static APK inspection is not a successful authenticated order subscription')
print('ORDER_WIRING_INSPECTION_COMPLETE')