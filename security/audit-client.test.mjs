import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {baseline, inspectClient, guardrails} from './audit-client.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('QUICK ADMIN does not restore administrator access from browser adminId',()=>{
  const report = inspectClient(html);
  assert.equal(report.legacyAutoRestore,false);
  assert.equal(report.storesAdminSessionId,false);
});

test('existing direct table exposures are inventoried rather than silently marked safe',()=>{
  const report=inspectClient(html);
  assert.equal(report.legacyPasswordBrowserLookup,true,
    'This legacy browser auth vulnerability remains until server migration.');
  assert.equal(report.sourceContainsSecureAdminGateway,false,
    'Do not incorrectly claim server-side gateway is active.');
  assert.deepEqual(report.directCalls,baseline,
    'Baseline must be reviewed whenever access paths are changed.');
});

test('client-side privilege restore regression is caught',()=>{
  const unsafe=html.replace(
    '// SECURITY_HARDENING_AUTORESTORE_DISABLED',
    '// missing safeguard'
  ).replace(
    'async function tryAutoLogin(){',
    "async function tryAutoLogin(){localStorage.getItem('qa_session');"
  );
  const findings=guardrails(inspectClient(unsafe));
  assert.ok(findings.includes('LOCAL_STORAGE_ADMIN_AUTORESTORE'));
});

test('new direct database tables are flagged',()=>{
  const injected=html+"<script>sb.from('secret_admin_table').select('*')</script>";
  const findings=guardrails(inspectClient(injected));
  assert.ok(findings.includes('NEW_DIRECT_TABLE_secret_admin_table'));
});

test('increases to existing direct database table access are flagged',()=>{
  const injected=html+"<script>sb.from('admins').select('*')</script>";
  const findings=guardrails(inspectClient(injected));
  assert.ok(findings.includes('DIRECT_ACCESS_INCREASE_admins'));
});

test('guardrails pass on development baseline without claiming security migration is complete',()=>{
  assert.deepEqual(guardrails(inspectClient(html)),[]);
});
