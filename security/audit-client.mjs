/**
 * QUICK ADMIN browser-side security inventory.
 *
 * STATIC ONLY. No network, credentials, or database mutations.
 * Baseline counts reflect security-branch index.html after unsafe auto-restore removal on 2026-11-03.
 * This does not claim existing direct access is secure.
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const baseline = Object.freeze({
  admins:10,
  branches:6,
  users:18,
  user_devices:5,
  withdrawn_users:2,
  payment_requests:12,
  announcements:4,
  app_settings:2
});

export function inspectClient(html) {
  const directCalls = {};
  const re = /\.from\(\s*['"]([a-z_]+)['"]\s*\)/g;
  for (const match of html.matchAll(re)) {
    const table = match[1];
    directCalls[table] = (directCalls[table] || 0) + 1;
  }
  const start = html.indexOf('async function tryAutoLogin(){');
  const next = html.indexOf('// ★ 비활동 타이머', start);
  const autoLoginSource = start >= 0 && next > start ? html.slice(start, next) : '';
  const legacyAutoRestore = /localStorage\.getItem\(['"]qa_session['"]\)|session\.adminId|\.from\(['"]admins['"]\)/.test(autoLoginSource);
  return {
    directCalls,
    legacyAutoRestore,
    storesAdminSessionId: /localStorage\.setItem\(['"]qa_session['"]/.test(html),
    legacyPasswordBrowserLookup: /\.from\(['"]admins['"]\)\.select\(['"]\*['"]\)\.eq\(['"]username['"]/.test(html),
    sourceContainsSecureAdminGateway: /SECURE_QA_ADMIN_GATEWAY_ACTIVE/.test(html)
  };
}

export function guardrails(report) {
  const violations = [];
  if (report.legacyAutoRestore) violations.push('LOCAL_STORAGE_ADMIN_AUTORESTORE');
  if (report.storesAdminSessionId) violations.push('LOCAL_STORAGE_ADMIN_ID_PERSISTENCE');
  for (const [table, count] of Object.entries(report.directCalls)) {
    if (!(table in baseline)) violations.push('NEW_DIRECT_TABLE_' + table);
    else if (count > baseline[table]) violations.push('DIRECT_ACCESS_INCREASE_' + table);
  }
  return violations;
}

const scriptFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (scriptFile && scriptFile === fileURLToPath(import.meta.url)) {
  const path = resolve(process.cwd(), 'index.html');
  const report = inspectClient(readFileSync(path, 'utf8'));
  const violations = guardrails(report);
  console.log('QUICK_ADMIN_CLIENT_AUDIT');
  console.log(JSON.stringify({
    ...report,
    findingsStillOpen: [
      'LEGACY_BROWSER_PASSWORD_LOOKUP',
      'SERVER_VERIFIED_ADMIN_SESSION_REQUIRED',
      'DIRECT_DATABASE_ACCESS_NEEDS_MIGRATION',
      'PUBLIC_TABLE_GRANTS_AND_RLS_REQUIRE_REVIEW'
    ],
    guardrailViolations:violations
  }, null, 2));
  if (process.argv.includes('--guardrails') && violations.length) process.exitCode = 1;
}
