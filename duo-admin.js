/* =====================================================================
 * duo-admin.js — QUICK ADMIN 부가 모듈: "DUO 관리"
 *
 *  - 별도 로그인 없음: 어드민 로그인(doLogin) 때 같은 아이디/비밀번호로 서버(duo-admin)에서
 *    관리자 확인 → DUO 관리자 세션 토큰 발급. 비밀번호는 저장하지 않는다.
 *  - 권한·범위 판단은 전부 서버. 이 화면은 서버가 준 권한(me.grant)대로 버튼만 보여준다.
 *    (화면에서 버튼을 살려도 서버가 거부 → fail-closed)
 *  - 기본은 권한 없음. 권한이 없는 관리자에게는 DUO 메뉴 자체가 보이지 않는다.
 *
 *  index.html 연결(5곳): 이 스크립트 태그 / doLogin 의 DUOA.login / tryAutoLogin 의 DUOA.restore /
 *                        doLogout 의 DUOA.logout / buildSidebar·navigate 의 DUO 메뉴
 * ===================================================================== */
(function () {
  'use strict';

  var API = 'https://pvdhdnvbgytfaydyyuat.supabase.co/functions/v1/duo-admin';
  var KEY = 'sb_publishable_EOg0NA9Ro8bbhseWNs7ENA_o_wOcfMD'; // 공개용 키 (비밀값 아님)
  var TOKEN_KEY = 'duo_admin_session'; // { token, adminId, exp }
  var STATUS = { pending: ['대기', 'bg-yellow'], approved: ['승인', 'bg-green'], rejected: ['반려', 'bg-red'], suspended: ['정지', 'bg-gray'] };
  var VEHICLES = ['오토바이', '플렉스', '다마스', '라보', '밴', '1t화물', '1.4t화물'];

  var me = null;          // 서버가 준 { admin, grant, branches, plans }
  var state = { tab: 'pending', filter: 'active', branch: 'all', q: '', list: [], loading: false, err: '', grants: null, rev: null, revMonth: '' };
  var dlg = null;

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function fmtPhone(v) { var d = digits(v); return d.length === 11 ? d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7) : d; }
  function fmtDate(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dday(iso) {
    if (!iso) return '<span class="badge bg-gray">없음</span>';
    var n = Math.ceil((new Date(iso) - Date.now()) / 86400000);
    return n < 0 ? '<span class="badge bg-red">만료</span>' : '<span class="badge ' + (n <= 3 ? 'bg-yellow' : 'bg-green') + '">D-' + n + '</span>';
  }
  function won(n) { return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)); }
  function toast(m, t) { try { showToast(m, t || 'info'); } catch (e) { } }
  // 서버 오류 메시지 + 원인(detail) — 원인 파악용
  // 실패 시 화면 위에 남는 오류 배너 (토스트는 2.5초 뒤 사라지므로)
  function fail(j) { state.notice = errMsg(j); toast(state.notice, 'error'); draw(); }
  function errMsg(j) { return (j.message || '실패했습니다.') + (j.detail ? ' [' + j.detail + ']' : '') + (j.code && !j.detail ? ' (' + j.code + ')' : ''); }
  function root() { return document.getElementById('duo-root'); }

  // ---------- 세션 ----------
  function getSess() {
    try {
      var s = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (!s || !s.token || s.exp < Date.now()) return null;
      if (window.curAcc && curAcc.id !== s.adminId) return null; // 다른 관리자로 로그인했으면 무효
      return s;
    } catch (e) { return null; }
  }
  function setSess(s) { try { if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { } }

  function api(body) {
    var s = getSess();
    var h = { apikey: KEY, 'Content-Type': 'application/json' };
    if (s) h['x-duo-admin-token'] = s.token;
    return fetch(API, { method: 'POST', headers: h, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: 'HTTP ' + r.status }; }).then(function (j) { j.http = r.status; return j; }); })
      .catch(function (e) { return { ok: false, http: 0, message: '서버에 연결할 수 없습니다.' }; })
      .then(function (j) {
        if (j.http === 401 && body.action !== 'login') { setSess(null); me = null; refreshNav(); }
        return j;
      });
  }

  function refreshNav() {
    try {
      if (typeof buildSidebar === 'function') buildSidebar();
      document.querySelectorAll('.ni').forEach(function (el) { el.classList.toggle('active', el.dataset.page === window.page); });
      if (window.page === 'duo' && root()) draw();
    } catch (e) { }
  }

  var DUOA = window.DUOA = {};
  DUOA.hasAccess = function () { return !!(me && me.grant); };

  // 어드민 로그인 직후 (같은 아이디/비밀번호) — 실패해도 어드민 로그인은 그대로 진행
  DUOA.login = function (username, password) {
    return api({ action: 'login', username: username, password: password }).then(function (j) {
      if (!j.ok) { setSess(null); me = null; return; }
      setSess({ token: j.token, adminId: (window.curAcc && curAcc.id) || null, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
      me = j.me;
      refreshNav();
    });
  };
  // 새로고침/자동 로그인 시: 저장된 세션이 유효하면 권한 다시 조회
  DUOA.restore = function () {
    if (!getSess()) { me = null; return Promise.resolve(); }
    return api({ action: 'me' }).then(function (j) { me = j.ok ? j.data : null; refreshNav(); });
  };
  DUOA.logout = function () {
    if (getSess()) api({ action: 'logout' });
    setSess(null); me = null;
  };

  // ---------- 데이터 ----------
  function loadMembers() {
    state.loading = true; state.err = ''; draw();
    var st = state.tab === 'pending' ? 'pending' : (state.filter === 'active' ? 'all' : state.filter);
    return api({ action: 'members', status: st }).then(function (j) {
      state.loading = false;
      if (!j.ok) { state.err = errMsg(j); state.list = []; }
      else state.list = j.data || [];
      draw();
    });
  }
  function loadGrants() {
    state.loading = true; draw();
    return api({ action: 'grants' }).then(function (j) { state.loading = false; state.grants = j.ok ? j.data : []; state.err = j.ok ? '' : j.message; draw(); });
  }
  function loadRevenue() {
    var m = state.revMonth || new Date().toISOString().slice(0, 7);
    state.revMonth = m;
    var from = new Date(m + '-01T00:00:00+09:00'), to = new Date(from); to.setMonth(to.getMonth() + 1);
    state.loading = true; draw();
    return api({ action: 'revenue', from: from.toISOString(), to: to.toISOString() }).then(function (j) { state.loading = false; state.rev = j.ok ? j.data : null; state.err = j.ok ? '' : j.message; draw(); });
  }
  function loadRelease() {
    state.loading = true; draw();
    return Promise.all([api({ action: 'release_get' }), api({ action: 'ui_get' })]).then(function (rs) {
      var j = rs[0]; state.loading = false; state.release = j.ok ? j.data : null; state.err = j.ok ? '' : errMsg(j);
      state.uiPolicy = rs[1].ok ? (rs[1].data || {}) : null; draw();
    });
  }
  function load() {
    if (state.tab === 'release') return loadRelease();
    if (state.tab === 'grants') return loadGrants();
    if (state.tab === 'revenue') return loadRevenue();
    return loadMembers();
  }

  // ---------- 화면 ----------
  function tabs() {
    var g = me.grant, t = [['pending', '⏳ 승인 대기'], ['members', '👥 회원']];
    if (g.delegate) t.push(['grants', '🔑 관리자 권한']);
    if (g.revenue) t.push(['revenue', '💰 매출']);
    if (g.delegate && g.scope === 'global') t.push(['release', '📦 앱 배포']);
    return '<div class="fbar">' + t.map(function (x) {
      return '<button class="fbtn' + (state.tab === x[0] ? ' on' : '') + '" onclick="DUOA.tab(\'' + x[0] + '\')">' + x[1] + '</button>';
    }).join('') + '</div>';
  }
  function scopeLabel(s) { return { global: '전체', subtree: '내 지점+하위', own: '내 지점' }[s] || s; }

  function header() {
    var g = me.grant;
    return '<div class="ph"><div><h1>DUO 관리</h1><p>' + esc(me.admin.name || me.admin.username) + ' · 범위: <b>' + scopeLabel(g.scope) + '</b>' +
      ' · 권한: ' + [g.members && '회원보기', g.approve && '승인/이용권', g.dual && '듀얼승인', g.revenue && '매출', g.delegate && '권한위임'].filter(Boolean).join(', ') + '</p></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
      (g.members && g.approve ? '<button class="btn btn-p" onclick="DUOA.openCreate()">+ 기사 직접 추가</button>' : '') +
      '<button class="btn btn-g" onclick="DUOA.reload()">🔄 새로고침</button></div></div>';
  }

  function memberRow(m) {
    var g = me.grant, st = STATUS[m.status] || [m.status, 'bg-gray'], b = [];
    if (m.status === 'pending' && g.approve) {
      b.push('<button class="btn btn-s btn-sm" onclick="DUOA.review(' + m.id + ',true)">승인</button>');
      b.push('<button class="btn btn-d btn-sm" onclick="DUOA.openReject(' + m.id + ')">반려</button>');
    }
    if (m.status === 'approved' && g.approve) {
      b.push('<button class="btn btn-p btn-sm" onclick="DUOA.openLicense(' + m.id + ')">이용권</button>');
      b.push('<button class="btn btn-g btn-sm" onclick="DUOA.setStatus(' + m.id + ',\'suspended\')">정지</button>');
    }
    if (m.status === 'approved' && g.dual) {
      b.push(m.tier === 'dual'
        ? '<button class="btn btn-g btn-sm" onclick="DUOA.dual(' + m.id + ',false)">듀얼 해제</button>'
        : '<button class="btn btn-b btn-sm" onclick="DUOA.dual(' + m.id + ',true)">듀얼 승인' + (m.dual_requested ? ' (신청)' : '') + '</button>');
    }
    if (m.status === 'suspended' && g.approve) b.push('<button class="btn btn-s btn-sm" onclick="DUOA.setStatus(' + m.id + ',\'approved\')">정지 해제</button>');
    return '<tr><td><b>' + esc(m.name) + '</b>' + (m.source === 'admin_created' ? ' <span class="badge bg-purple">직접추가</span>' : '') + '</td>' +
      '<td style="font-size:11px">' + esc(fmtPhone(m.phone)) + '</td>' +
      '<td style="font-size:11px">' + esc(m.branch_name || '—') + '</td>' +
      '<td style="font-size:11px">' + esc(m.vehicle || '—') + '</td>' +
      '<td style="font-size:11px;color:var(--text2)">' + fmtDate(m.created_at) + '</td>' +
      '<td><span class="badge ' + st[1] + '">' + st[0] + '</span>' + (m.tier === 'dual' ? ' <span class="badge bg-blue">듀얼</span>' : '') +
      (m.reason && m.status !== 'approved' ? '<div style="font-size:10px;color:var(--text2)">' + esc(m.reason) + '</div>' : '') + '</td>' +
      '<td>' + (m.status === 'approved' || m.status === 'suspended' ? fmtDate(m.license_expires_at) + ' ' + dday(m.license_expires_at) : '—') + '</td>' +
      '<td><div style="display:flex;gap:4px;flex-wrap:wrap">' + (b.join('') || '<span style="font-size:11px;color:var(--text2)">—</span>') + '</div></td></tr>';
  }

  // 소속별 보기: 기존 회원관리와 같은 총판 → 지사 → 지점 목록. 상위 선택 시 하위 소속 포함 (보기 필터일 뿐, 범위 제한은 서버)
  function branchSelect() {
    try { if (typeof buildBranchFilterSelect === 'function') return buildBranchFilterSelect('duo-branch-filter', state.branch, 'DUOA.branch(this.value)'); } catch (e) { }
    return '<select class="fi2" id="duo-branch-filter" onchange="DUOA.branch(this.value)"><option value="all">📋 전체 소속</option>' +
      (me.branches || []).map(function (b) { return '<option value="' + b.id + '"' + (String(state.branch) === String(b.id) ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('') + '</select>';
  }
  function inBranch(m) {
    if (state.branch === 'all') return true;
    try { if (typeof matchBranchFilter === 'function') return matchBranchFilter(m.branch_id, state.branch); } catch (e) { }
    return String(m.branch_id) === String(state.branch);
  }
  function membersHtml() {
    var h = '<div class="card" style="padding:14px;margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
      '<div style="min-width:220px"><label class="fl">🏢 소속별 보기</label>' + branchSelect() + '</div>' +
      '<div style="flex:1;min-width:180px"><label class="fl">🔍 이름/번호 검색</label><input class="fi2" id="duo-q" placeholder="이름/번호 검색" value="' + esc(state.q) + '" oninput="DUOA.search(this.value)"></div>' +
      (state.branch !== 'all' || state.q ? '<button class="btn btn-g btn-sm" onclick="DUOA.branch(\'all\',true)">초기화</button>' : '') + '</div></div>';
    if (state.tab === 'members') {
      h += '<div class="fbar">' + [['active', '이용중 (승인+정지)'], ['approved', '승인'], ['suspended', '정지'], ['rejected', '반려'], ['all', '전체']].map(function (x) {
        return '<button class="fbtn' + (state.filter === x[0] ? ' on' : '') + '" onclick="DUOA.filter(\'' + x[0] + '\')">' + x[1] + '</button>';
      }).join('') + '</div>';
    }
    var q = state.q.trim(), list = state.list.filter(function (m) { return (state.tab !== 'members' || state.filter !== 'active' || m.status === 'approved' || m.status === 'suspended') && inBranch(m) && (!q || (m.name || '').indexOf(q) >= 0 || digits(m.phone).indexOf(digits(q) || '\u0000') >= 0); });
    h += '<div class="card" style="padding:0"><div class="card-head" style="padding:12px 16px"><div class="card-title">' + (state.tab === 'pending' ? '가입 승인 대기' : 'DUO 회원') + '</div><span style="font-size:11px;color:var(--text2)">' + list.length + '명</span></div>';
    if (!list.length) return h + '<div class="empty"><div class="empty-icon">' + (state.tab === 'pending' ? '✅' : '👤') + '</div><div class="empty-txt">' + (state.tab === 'pending' ? '대기 중인 가입 신청이 없습니다' : '해당 회원이 없습니다') + '</div></div></div>';
    return h + '<div class="tw"><table><thead><tr><th>기사</th><th>휴대폰</th><th>지점</th><th>차종</th><th>신청일</th><th>상태</th><th>이용기간</th><th>관리</th></tr></thead><tbody>' +
      list.map(memberRow).join('') + '</tbody></table></div></div>';
  }

  var FLAGS = [['members', '회원보기'], ['approve', '승인·이용권'], ['dual', '듀얼승인'], ['revenue', '매출'], ['delegate', '권한위임']];
  function grantsHtml() {
    var mine = me.grant, list = state.grants || [];
    var h = '<div class="alert a-blue" style="margin-bottom:12px">기본은 권한 없음입니다. 본인에게 있는 권한과 범위 안에서만 다른 관리자에게 줄 수 있습니다. 매출 권한은 회원 관리 권한과 별개입니다.</div>';
    h += '<div class="card" style="padding:0"><div class="tw"><table><thead><tr><th>관리자</th><th>지점</th>' + FLAGS.map(function (f) { return '<th>' + f[1] + '</th>'; }).join('') + '<th>범위</th><th></th></tr></thead><tbody>';
    list.forEach(function (a) {
      var g = a.grant || {}, dis = a.self ? ' disabled' : '';
      h += '<tr><td><b>' + esc(a.name) + '</b><div style="font-size:11px;color:var(--text2)">@' + esc(a.username) + ' · ' + esc(a.role || '') + '</div></td>' +
        '<td style="font-size:11px">' + esc(a.branch_name || '—') + '</td>' +
        FLAGS.map(function (f) {
          var can = mine[f[0]];
          return '<td><input type="checkbox" id="dg-' + a.admin_id + '-' + f[0] + '"' + (g[f[0]] ? ' checked' : '') + (a.self || !can ? ' disabled' : '') + '></td>';
        }).join('') +
        '<td><select class="fi2" style="min-width:110px" id="dg-' + a.admin_id + '-scope"' + dis + '>' + ['own', 'subtree', 'global'].filter(function (s) {
          return ({ own: 1, subtree: 2, global: 3 })[s] <= ({ own: 1, subtree: 2, global: 3 })[mine.scope];
        }).map(function (s) { return '<option value="' + s + '"' + ((g.scope || 'own') === s ? ' selected' : '') + '>' + scopeLabel(s) + '</option>'; }).join('') + '</select></td>' +
        '<td style="white-space:nowrap">' + (a.self ? '<span style="font-size:11px;color:var(--text2)">본인</span>' :
          '<button class="btn btn-p btn-sm" onclick="DUOA.saveGrant(' + a.admin_id + ')">저장</button> ' +
          (a.grant ? '<button class="btn btn-d btn-sm" onclick="DUOA.revokeGrant(' + a.admin_id + ')">회수</button>' : '')) + '</td></tr>';
    });
    return h + '</tbody></table></div></div>';
  }

  var PLAN_LABEL = { duo_standard: 'DUO 일반', duo_dual: 'DUO 듀얼', duo_trial: '체험', duo_custom: '직접 지정' };
  function revRows() { return ((state.rev && state.rev.rows) || []).filter(inBranch); }
  function revenueHtml() {
    var r = state.rev;
    var h = '<div class="card" style="padding:14px;margin-bottom:12px"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">' +
      '<div><label class="fl">📅 조회 월</label><input class="fi2" type="month" style="width:170px" value="' + esc(state.revMonth) + '" onchange="DUOA.revMonth(this.value)"></div>' +
      '<div style="min-width:220px"><label class="fl">🏢 소속별 보기</label>' + branchSelect() + '</div>' +
      '<div style="flex:1;min-width:160px"><label class="fl">🔍 기사/입금자 검색</label><input class="fi2" id="duo-q" placeholder="이름/번호/입금자" value="' + esc(state.q) + '" oninput="DUOA.search(this.value)"></div>' +
      (r && r.rows && r.rows.length ? '<button class="btn btn-g btn-sm" onclick="DUOA.revCsv()">📊 엑셀(CSV)</button>' : '') + '</div></div>';
    if (!r) return h;
    var q = state.q.trim();
    var rows = revRows().filter(function (x) { return !q || (x.name || '').indexOf(q) >= 0 || (x.payer || '').indexOf(q) >= 0 || (digits(q) && digits(x.phone).indexOf(digits(q)) >= 0); });
    var sum = { total: 0, paid: 0 }, by = {};
    rows.forEach(function (x) { sum.total += x.amount || 0; if (x.amount > 0) sum.paid++; by[x.plan] = (by[x.plan] || 0) + (x.amount || 0); });
    h += '<div class="sgrid sg4" style="margin-bottom:12px">' +
      '<div class="scard"><div class="slabel">매출 합계</div><div class="sval">' + won(sum.total) + '</div><div class="ssub">유료 ' + sum.paid + '건 · 전체 ' + rows.length + '건</div></div>' +
      '<div class="scard"><div class="slabel">DUO 일반</div><div class="sval">' + won(by.duo_standard) + '</div></div>' +
      '<div class="scard"><div class="slabel">DUO 듀얼</div><div class="sval">' + won(by.duo_dual) + '</div></div>' +
      '<div class="scard"><div class="slabel">직접 지정</div><div class="sval">' + won(by.duo_custom) + '</div><div class="ssub">체험 0원 제외</div></div></div>';
    h += '<div class="card" style="padding:0"><div class="card-head" style="padding:12px 16px"><div class="card-title">이용권 부여 내역 (입금 확인용)</div><span style="font-size:11px;color:var(--text2)">' + rows.length + '건</span></div>';
    if (!rows.length) return h + '<div class="empty"><div class="empty-icon">💰</div><div class="empty-txt">해당 기간·소속의 이용권 부여 내역이 없습니다</div></div></div>';
    return h + '<div class="tw"><table><thead><tr><th>일시</th><th>기사</th><th>지점</th><th>이용권</th><th>금액</th><th>입금자</th><th>기간 변경</th><th>처리자</th></tr></thead><tbody>' +
      rows.map(function (x) {
        return '<tr><td style="font-size:11px;white-space:nowrap">' + fmtDate(x.at) + ' ' + esc(new Date(x.at).toTimeString().slice(0, 5)) + '</td>' +
          '<td><b>' + esc(x.name) + '</b><div style="font-size:11px;color:var(--text2)">' + esc(fmtPhone(x.phone)) + '</div></td>' +
          '<td style="font-size:11px">' + esc(x.branch_name || '—') + '</td>' +
          '<td><span class="badge ' + (x.amount > 0 ? 'bg-green' : 'bg-gray') + '">' + esc(PLAN_LABEL[x.plan] || x.plan_name || x.plan) + '</span><div style="font-size:11px;color:var(--text2)">' + x.days + '일</div></td>' +
          '<td style="font-weight:700;white-space:nowrap">' + won(x.amount) + '</td>' +
          '<td style="font-size:12px">' + esc(x.payer || '—') + (x.memo ? '<div style="font-size:11px;color:var(--text2)">' + esc(x.memo) + '</div>' : '') + '</td>' +
          '<td style="font-size:11px;white-space:nowrap">' + fmtDate(x.prior) + ' → <b>' + fmtDate(x.until) + '</b></td>' +
          '<td style="font-size:11px">' + esc(x.operator || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function releaseHtml() {
    var d = (state.release || {}).dev, up = state.up || {};
    var cur = !d ? '<div class="empty-txt" style="padding:8px 0">아직 배포된 버전이 없습니다.</div>' :
      '<div class="sgrid sg4"><div class="scard"><div class="slabel">최신 버전</div><div class="sval">' + esc(d.latest) + '</div><div class="ssub">' + (d.published ? '게시 중' : '미게시') + '</div></div>' +
      '<div class="scard"><div class="slabel">최소 버전 (이하 필수 업데이트)</div><div class="sval">' + esc(d.min) + '</div></div>' +
      '<div class="scard"><div class="slabel">배포 일시</div><div class="sval" style="font-size:16px">' + fmtDate(d.changed_at) + '</div><div class="ssub">' + esc(d.changed_at ? new Date(d.changed_at).toTimeString().slice(0, 5) : '') + '</div></div>' +
      '<div class="scard"><div class="slabel">파일 검증값 (SHA-256)</div><div class="sval" style="font-size:13px;word-break:break-all">' + esc((d.sha256 || '').slice(0, 16)) + '…</div><div class="ssub">' + esc(d.message || '') + '</div></div></div>';
    return '<div class="alert a-blue" style="margin-bottom:12px">Android Studio 로 빌드한 <b>duo-버전코드-debug.apk</b> 를 올리면, 기사 앱이 다음 실행 때 <b>앱 안에서 업데이트</b>를 안내합니다. ' +
      '같은 PC(같은 서명키)에서 빌드한 APK 만 기존 앱 위에 설치됩니다.</div>' +
      '<div class="card" style="padding:14px;margin-bottom:12px"><div class="card-title" style="margin-bottom:10px">현재 배포 (개발용 채널)</div>' + cur + '</div>' +
      '<div class="card" style="padding:14px"><div class="card-title" style="margin-bottom:10px">새 버전 배포</div>' +
      '<div class="fg"><label class="fl">APK 파일 *</label><input class="fi2" type="file" id="duo-apk-file" accept=".apk,application/vnd.android.package-archive" onchange="DUOA.apkPicked(this)"></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><div class="fg" style="width:180px"><label class="fl">버전 코드 *</label><input class="fi2" id="duo-apk-ver" inputmode="numeric" value="' + esc(up.ver || '') + '" placeholder="파일 이름에서 자동"></div>' +
      '<div class="fg" style="flex:1;min-width:220px"><label class="fl">안내 문구 (기사에게 표시)</label><input class="fi2" id="duo-apk-msg" maxlength="200" value="' + esc(up.msg || '') + '" placeholder="예) 오더 화면 개선"></div></div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin:4px 0 12px"><input type="checkbox" id="duo-apk-force"' + (up.force ? ' checked' : '') + '> <b>필수 업데이트</b> <span style="font-size:12px;color:var(--text2)">(체크하면 업데이트 전까지 앱 사용 불가)</span></label>' +
      (up.status ? '<div class="alert ' + (up.error ? 'a-red' : 'a-blue') + '" style="margin-bottom:10px;word-break:break-all">' + esc(up.status) + '</div>' : '') +
      '<button class="btn btn-p" id="duo-apk-go" onclick="DUOA.apkPublish()"' + (up.busy ? ' disabled' : '') + '>' + (up.busy ? '<span class="loading"></span> 업로드 중…' : '📦 업로드 후 배포') + '</button></div>' +
      uiReleaseHtml();
  }

  // ── 화면(HTML) 무설치 업데이트 ──
  function uiVersionNow() { return 100000 + Math.floor((Date.now() - Date.parse('2026-01-01T00:00:00+09:00')) / 60000); }
  function uiReleaseHtml() {
    var u = (state.uiPolicy || {}).dev, ui = state.ui || {}, apk = ((state.release || {}).dev || {}).latest || '';
    return '<div class="card" style="padding:14px;margin-top:12px"><div class="card-title" style="margin-bottom:8px">🖼️ 화면 배포 (APK 없이 바로 반영)</div>' +
      '<div class="alert a-blue" style="margin-bottom:10px">duo-main.html / duo-login.html 을 고쳤을 때 사용합니다. 기사 앱은 <b>다음 실행 때 자동 반영</b>됩니다. ' +
      '형님 PC 의 <b>서명 키 파일</b>로 서명한 화면만 앱이 받아들입니다 (서버가 뚫려도 가짜 화면 불가).</div>' +
      '<div style="font-size:13px;margin-bottom:10px">현재 화면 버전: <b>' + (u ? esc(u.version) + '</b> · ' + fmtDate(u.changed_at) + (u.message ? ' · ' + esc(u.message) : '') + ' · 최소 앱 ' + esc(u.min_apk) : '없음</b> (APK 기본 화면)') + '</div>' +
      '<details style="margin-bottom:12px"><summary style="cursor:pointer;font-weight:700">🔑 서명 키 (처음 1번)</summary><div style="padding:10px 0">' +
      '<ol style="margin:0 0 8px 18px;font-size:13px;line-height:1.7"><li>[서명 키 만들기] → 파일 2개가 PC 에 저장됩니다.</li>' +
      '<li><b>duo-ui-signing-key.json</b> = 개인키. PC 에 안전하게 보관 (누구에게도 보내지 말 것, 잃어버리면 새로 만들고 APK 다시 배포)</li>' +
      '<li><b>duo-ui-pubkey.txt</b> = 공개키. DUO_LIVE_DEV 프로젝트 폴더(맨 위)에 넣고 APK 빌드 → 위 [앱 배포] 로 배포</li></ol>' +
      '<button class="btn btn-g btn-sm" onclick="DUOA.uiKeygen()">🔑 서명 키 만들기</button></div></details>' +
      '<div class="fg"><label class="fl">화면 파일 * (duo-main.html, duo-login.html 중 고친 것)</label><input class="fi2" type="file" id="duo-ui-files" accept=".html" multiple></div>' +
      '<div class="fg"><label class="fl">서명 키 파일 * (duo-ui-signing-key.json)</label><input class="fi2" type="file" id="duo-ui-key" accept=".json"></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><div class="fg" style="width:200px"><label class="fl">최소 앱 버전</label><input class="fi2" id="duo-ui-minapk" inputmode="numeric" value="' + esc(ui.minApk || apk) + '"><div class="fd">이 버전 미만 앱엔 적용 안 함</div></div>' +
      '<div class="fg" style="flex:1;min-width:220px"><label class="fl">메모</label><input class="fi2" id="duo-ui-msg" maxlength="200" value="' + esc(ui.msg || '') + '" placeholder="예) 오더 카드 글자 크게"></div></div>' +
      (ui.status ? '<div class="alert ' + (ui.error ? 'a-red' : 'a-blue') + '" style="margin-bottom:10px;word-break:break-all">' + esc(ui.status) + '</div>' : '') +
      '<button class="btn btn-p" onclick="DUOA.uiPublish()"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? '<span class="loading"></span> 배포 중…' : '🖼️ 서명 후 화면 배포') + '</button></div>';
  }
  function b64(buf) { var s = '', b = new Uint8Array(buf); for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function saveFile(name, text) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  function readText(f) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = no; r.readAsText(f); }); }
  function readBuf(f) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(r.result); }; r.onerror = no; r.readAsArrayBuffer(f); }); }

  function draw() {
    var r = root(); if (!r) return;
    if (!me || !me.grant) {
      r.innerHTML = '<div class="empty"><div class="empty-icon">🔒</div><div class="empty-txt">DUO 관리자 세션이 없습니다.<br>로그아웃 후 다시 로그인하면 연결됩니다.</div></div>';
      return;
    }
    var body = state.loading ? '<div class="empty"><div class="empty-txt"><span class="loading"></span> 불러오는 중...</div></div>'
      : state.err ? '<div class="alert a-red">' + esc(state.err) + '</div>'
      : state.tab === 'grants' ? grantsHtml() : state.tab === 'revenue' ? revenueHtml() : state.tab === 'release' ? releaseHtml() : membersHtml();
    var notice = state.notice ? '<div class="alert a-red" style="margin-bottom:12px;display:flex;gap:8px;align-items:flex-start"><div style="flex:1;word-break:break-all">⚠️ ' + esc(state.notice) + '</div><button class="btn btn-g btn-sm" onclick="DUOA.clearNotice()">닫기</button></div>' : '';
    r.innerHTML = header() + notice + tabs() + body;
  }

  // ---------- 다이얼로그 ----------
  function dialogEl() {
    var m = document.getElementById('duo-dialog');
    if (!m) { m = document.createElement('div'); m.id = 'duo-dialog'; m.className = 'modal-bg'; document.body.appendChild(m); }
    return m;
  }
  function openDialog(title, inner, okLabel, okFn) {
    dlg = { ok: okFn };
    var m = dialogEl();
    m.innerHTML = '<div class="modal-box" style="max-width:440px"><div class="mh"><div class="mt">' + title + '</div><button class="mc" onclick="DUOA.close()">×</button></div>' +
      inner + '<div class="alert a-red" id="duo-d-err" style="display:none;margin-top:8px"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end"><button class="btn btn-g" onclick="DUOA.close()">취소</button>' +
      '<button class="btn btn-p" id="duo-d-ok" onclick="DUOA.submit()">' + okLabel + '</button></div></div>';
    m.classList.add('open');
  }
  function dlgErr(msg) { var e = document.getElementById('duo-d-err'); if (e) { e.textContent = msg; e.style.display = 'block'; } var b = document.getElementById('duo-d-ok'); if (b) b.disabled = false; }
  DUOA.clearNotice = function () { state.notice = ''; draw(); };
  DUOA.close = function () { var m = document.getElementById('duo-dialog'); if (m) m.classList.remove('open'); dlg = null; };
  DUOA.submit = function () { if (!dlg) return; var b = document.getElementById('duo-d-ok'); if (b) b.disabled = true; dlg.ok(); };
  function find(id) { return state.list.filter(function (m) { return m.id === id; })[0] || {}; }
  function after(j, okMsg) {
    if (!j.ok) { dlgErr(errMsg(j)); fail(j); return false; }
    DUOA.close(); toast(okMsg, 'success'); load(); return true;
  }

  // ---------- 동작 ----------
  DUOA.tab = function (t) { state.tab = t; state.q = ''; state.err = ''; load(); };
  DUOA.filter = function (f) { state.filter = f; load(); };
  DUOA.branch = function (v, resetSearch) { state.branch = v || 'all'; if (resetSearch) state.q = ''; draw(); };
  DUOA.search = function (v) { state.q = v; var r = root(); var pos = document.activeElement && document.activeElement.selectionStart; draw(); var i = document.getElementById('duo-q'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) { } } };
  DUOA.reload = function () { DUOA.restore().then(load); };
  DUOA.revMonth = function (v) { state.revMonth = v; loadRevenue(); };

  DUOA.review = function (id, approve) {
    var m = find(id);
    if (!confirm((m.name || '') + ' 님의 DUO 가입을 승인할까요?\n(이용권은 승인 후 따로 부여합니다)')) return;
    api({ action: 'review', member_id: id, approve: true }).then(function (j) { if (!j.ok) return fail(j); toast('승인했습니다', 'success'); load(); });
  };
  DUOA.openReject = function (id) {
    var m = find(id);
    openDialog('반려 — ' + esc(m.name), '<div class="fg"><label class="fl">반려 사유 (기사에게 표시될 수 있음)</label><input class="fi2" id="duo-reason" maxlength="200" placeholder="예) 지점 확인 불가"></div>', '반려', function () {
      api({ action: 'review', member_id: id, approve: false, reason: document.getElementById('duo-reason').value }).then(function (j) { after(j, '반려했습니다'); });
    });
  };
  DUOA.setStatus = function (id, st) {
    var m = find(id);
    if (st === 'suspended') {
      openDialog('이용 정지 — ' + esc(m.name), '<div class="fg"><label class="fl">정지 사유</label><input class="fi2" id="duo-reason" maxlength="200"></div><div class="fd">정지하면 기사 앱은 즉시 사용할 수 없습니다. 이용기간은 그대로 유지됩니다.</div>', '정지', function () {
        api({ action: 'set_status', member_id: id, status: 'suspended', reason: document.getElementById('duo-reason').value }).then(function (j) { after(j, '정지했습니다'); });
      });
    } else {
      if (!confirm((m.name || '') + ' 님의 정지를 해제할까요?\n(해제하면 남은 이용기간 동안 바로 앱을 쓸 수 있습니다)')) return;
      api({ action: 'set_status', member_id: id, status: 'approved' }).then(function (j) { if (!j.ok) return fail(j); toast('정지를 해제했습니다', 'success'); load(); });
    }
  };
  DUOA.dual = function (id, approve) {
    var m = find(id);
    if (!confirm((m.name || '') + (approve ? ' 님을 듀얼 이용자로 승인할까요?' : ' 님의 듀얼 승인을 해제할까요?'))) return;
    api({ action: 'dual', member_id: id, approve: approve }).then(function (j) { if (!j.ok) return fail(j); toast(approve ? '듀얼 승인했습니다' : '듀얼 해제했습니다', 'success'); load(); });
  };
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  DUOA.openLicense = function (id) {
    var m = find(id), plans = (me.plans || []), idem = uuid();
    var base = new Date(Math.max(Date.now(), m.license_expires_at ? new Date(m.license_expires_at).getTime() : 0));
    var minD = new Date(base.getTime() + 86400000), defD = new Date(base.getTime() + 30 * 86400000);
    var row = function (inner, dis) { return '<label style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 0;' + (dis ? 'opacity:.45' : '') + '">' + inner + '</label>'; };
    var opts = plans.map(function (p) {
      var dis = p.code === 'duo_dual' && m.tier !== 'dual';
      return row('<input type="radio" name="duo-kind" value="' + esc(p.code) + '"' + (dis ? ' disabled' : '') + '> <b>' + esc(PLAN_LABEL[p.code] || p.name) + '</b> · ' + won(p.price) + ' · ' + p.days + '일' + (dis ? ' <span style="font-size:11px">(듀얼 승인 필요)</span>' : ''), dis);
    }).join('');
    openDialog('이용권 부여 — ' + esc(m.name),
      '<div class="fd" style="margin-bottom:4px">현재 만료일: <b>' + fmtDate(m.license_expires_at) + '</b> · 상품/체험은 남은 기간 뒤에 이어서 더해집니다.</div>' + opts +
      row('<input type="radio" name="duo-kind" value="trial" checked> <b>체험</b> · 0원 · <input class="fi2" id="duo-days" type="number" min="1" max="60" value="3" style="width:80px" onfocus="DUOA.pick(\'trial\')"> 일') +
      row('<input type="radio" name="duo-kind" value="custom"> <b>직접 지정</b> · 만료일 <input class="fi2" id="duo-until" type="date" min="' + ymd(minD) + '" value="' + ymd(defD) + '" style="width:160px" onfocus="DUOA.pick(\'custom\')">' +
        ' · 금액 <input class="fi2" id="duo-amount" inputmode="numeric" placeholder="0" style="width:120px" onfocus="DUOA.pick(\'custom\')" oninput="this.value=this.value.replace(/[^0-9]/g,\'\').replace(/\\B(?=(\\d{3})+(?!\\d))/g,\',\')"> 원') +
      '<div class="fd" style="margin:-2px 0 8px 24px">직접 지정: 고른 날짜 <b>그날 밤 23:59</b>까지 이용 가능. 금액은 실제 입금액 (무료면 0)</div>' +
      '<div style="display:flex;gap:8px"><div class="fg" style="flex:1;margin:0"><label class="fl">입금자명</label><input class="fi2" id="duo-payer" maxlength="40" placeholder="기사와 다르면 입력"></div>' +
      '<div class="fg" style="flex:1.4;margin:0"><label class="fl">메모</label><input class="fi2" id="duo-memo" maxlength="200" placeholder="예) 계좌이체 10/20"></div></div>',
      '부여', function () {
        var k = (document.querySelector('input[name="duo-kind"]:checked') || {}).value;
        var body = { action: 'license', member_id: id, kind: k, idem: idem,
          payer: document.getElementById('duo-payer').value, memo: document.getElementById('duo-memo').value };
        if (k === 'trial') body.days = parseInt(document.getElementById('duo-days').value, 10);
        if (k === 'custom') {
          body.until = document.getElementById('duo-until').value;
          var a = digits(document.getElementById('duo-amount').value);
          if (!body.until) return dlgErr('만료일을 선택하세요.');
          if (a === '') return dlgErr('금액을 입력하세요. (무료면 0)');
          body.amount = parseInt(a, 10);
        }
        api(body).then(function (j) {
          after(j, j.ok ? '이용권 부여 · ' + won(j.data.amount) + ' · 만료 ' + fmtDate(j.data.license_expires_at) : '');
        });
      });
  };
  DUOA.uiKeygen = function () {
    if (!confirm('새 서명 키를 만들까요?\n이미 키를 쓰고 있다면, 새 키로 바꾸는 순간 기존 앱은 새 공개키가 든 APK 를 받기 전까지 화면 업데이트를 받지 않습니다.')) return;
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']).then(function (kp) {
      return Promise.all([crypto.subtle.exportKey('jwk', kp.privateKey), crypto.subtle.exportKey('spki', kp.publicKey)]);
    }).then(function (r) {
      var pub = b64(r[1]);
      saveFile('duo-ui-signing-key.json', JSON.stringify({ kind: 'DUO UI signing key (PRIVATE - do not share)', created: new Date().toISOString(), jwk: r[0], pub: pub }, null, 1));
      setTimeout(function () { saveFile('duo-ui-pubkey.txt', pub); }, 400);
      toast('서명 키 파일 2개를 저장했습니다', 'success');
      state.ui = { status: '🔑 키 생성 완료 · 공개키 지문 ' + pub.slice(-16) + ' → duo-ui-pubkey.txt 를 프로젝트 폴더에 넣고 APK 빌드·배포하세요.' }; draw();
    }).catch(function (e) { state.ui = { error: true, status: '키 생성 실패: ' + e }; draw(); });
  };
  DUOA.uiPublish = function () {
    var files = Array.prototype.slice.call(document.getElementById('duo-ui-files').files || []);
    var keyF = (document.getElementById('duo-ui-key').files || [])[0];
    var minApk = parseInt(digits(document.getElementById('duo-ui-minapk').value), 10) || 1;
    var msg = document.getElementById('duo-ui-msg').value;
    var ui = state.ui = { minApk: minApk, msg: msg };
    var stop = function (t) { ui.busy = false; ui.error = true; ui.status = t; draw(); };
    var allowed = ['duo-main.html', 'duo-login.html'];
    if (!files.length) return stop('화면 파일을 선택하세요.');
    var bad = files.filter(function (f) { return allowed.indexOf(f.name) < 0; });
    if (bad.length) return stop('파일 이름은 duo-main.html 또는 duo-login.html 이어야 합니다: ' + bad.map(function (f) { return f.name; }).join(', '));
    if (!keyF) return stop('서명 키 파일(duo-ui-signing-key.json)을 선택하세요.');
    var version = uiVersionNow(), cur = (state.uiPolicy || {}).dev;
    if (cur && version <= cur.version) version = cur.version + 1;
    ui.busy = true; ui.error = false; ui.status = '서명 중…'; draw();
    var key, pub, list = [], bufs = {};
    readText(keyF).then(function (t) {
      var k = JSON.parse(t); if (!k.jwk || !k.jwk.d) throw new Error('서명 키 파일이 아닙니다');
      pub = k.pub || '';
      return crypto.subtle.importKey('jwk', k.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    }).then(function (k) {
      key = k;
      return Promise.all(files.map(function (f) { return readBuf(f).then(function (b) { bufs[f.name] = b; return crypto.subtle.digest('SHA-256', b).then(function (h) { list.push({ name: f.name, sha256: hex(h), size: b.byteLength }); }); }); }));
    }).then(function () {
      list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      var manifest = JSON.stringify({ version: version, minApk: minApk, files: list, created: new Date().toISOString() });
      return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(manifest)).then(function (sig) { return { manifest: manifest, sig: b64(sig) }; });
    }).then(function (signed) {
      ui.status = '업로드 중…'; draw();
      return api({ action: 'ui_upload_urls', version: version, channel: 'dev', files: list.map(function (f) { return f.name; }) }).then(function (j) {
        if (!j.ok) throw new Error(errMsg(j));
        var u = j.data.uploads, put = function (name, body, type) { return sb.storage.from(j.data.bucket).uploadToSignedUrl(u[name].path, u[name].token, new Blob([body], { type: type })).then(function (r) { if (r.error) throw new Error(name + ' 업로드 실패: ' + r.error.message); }); };
        return Promise.all([put('manifest.json', signed.manifest, 'application/json'), put('manifest.sig', signed.sig, 'text/plain')]
          .concat(list.map(function (f) { return put(f.name, bufs[f.name], 'text/html'); }))).then(function () { return j.data.dir; });
      });
    }).then(function (dir) {
      ui.status = '서버 확인 및 게시 중…'; draw();
      return api({ action: 'ui_publish', version: version, channel: 'dev', dir: dir, message: msg });
    }).then(function (p) {
      if (!p.ok) throw new Error(errMsg(p));
      state.ui = { status: '✅ 화면 배포 완료 · 버전 ' + p.data.version + ' · ' + p.data.files.join(', ') + ' · 최소 앱 ' + p.data.min_apk + ' · 서명키 지문 ' + (pub ? pub.slice(-16) : '?') };
      toast('화면을 배포했습니다 (기사 앱 다음 실행 때 반영)', 'success'); loadRelease();
    }).catch(function (e) { stop(String(e.message || e)); });
  };
  DUOA.apkPicked = function (input) {
    var f = input.files && input.files[0]; state.up = state.up || {};
    var m = f && /duo-(\d+)-/.exec(f.name);
    if (m) { state.up.ver = m[1]; var v = document.getElementById('duo-apk-ver'); if (v) v.value = m[1]; }
  };
  DUOA.apkPublish = function () {
    var f = (document.getElementById('duo-apk-file').files || [])[0];
    var ver = parseInt(digits(document.getElementById('duo-apk-ver').value), 10);
    var msg = document.getElementById('duo-apk-msg').value, force = document.getElementById('duo-apk-force').checked;
    var up = state.up = { ver: ver || '', msg: msg, force: force };
    var stop = function (t) { up.busy = false; up.error = true; up.status = t; draw(); };
    if (!f) return stop('APK 파일을 선택하세요.');
    if (!/\.apk$/i.test(f.name)) return stop('.apk 파일만 올릴 수 있습니다.');
    if (!ver) return stop('버전 코드를 입력하세요. (파일 이름 duo-버전코드-debug.apk)');
    var d = (state.release || {}).dev;
    if (d && ver <= d.latest && !confirm('이미 배포된 버전(' + d.latest + ')보다 크지 않습니다. 계속할까요?')) return;
    if (force && !confirm('필수 업데이트로 배포하면, 이전 버전 기사 앱은 업데이트 전까지 사용할 수 없습니다. 배포할까요?')) return;
    if (typeof sb === 'undefined' || !sb.storage) return stop('업로드 모듈(Supabase)을 불러오지 못했습니다.');
    up.busy = true; up.error = false; up.status = '업로드 준비 중… (' + (f.size / 1048576).toFixed(1) + ' MB)'; draw();
    api({ action: 'apk_upload_url', version_code: ver, channel: 'dev' }).then(function (j) {
      if (!j.ok) return stop(errMsg(j));
      up.status = '업로드 중… (' + (f.size / 1048576).toFixed(1) + ' MB)'; draw();
      return sb.storage.from(j.data.bucket).uploadToSignedUrl(j.data.path, j.data.token, f, { contentType: 'application/vnd.android.package-archive' })
        .then(function (r) {
          if (r.error) return stop('업로드 실패: ' + r.error.message);
          up.status = '서버 검증 및 배포 중…'; draw();
          return api({ action: 'apk_publish', version_code: ver, channel: 'dev', path: j.data.path, message: msg, force: force }).then(function (p) {
            if (!p.ok) return stop(errMsg(p));
            state.up = { status: '✅ 배포 완료 · 버전 ' + p.data.latest + ' · 최소 ' + p.data.min + ' · ' + (p.data.size / 1048576).toFixed(1) + ' MB · SHA-256 ' + p.data.sha256.slice(0, 16) + '…' };
            toast('앱 업데이트를 배포했습니다', 'success'); loadRelease();
          });
        });
    }).catch(function (e) { stop('오류: ' + e); });
  };
  DUOA.pick = function (k) { var r = document.querySelector('input[name="duo-kind"][value="' + k + '"]'); if (r) r.checked = true; };
  DUOA.revCsv = function () {
    var rows = revRows(), head = ['일시', '기사', '휴대폰', '지점', '이용권', '기간(일)', '금액', '입금자', '메모', '이전 만료', '새 만료', '처리자'];
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var csv = '﻿' + [head.join(',')].concat(rows.map(function (x) {
      return [new Date(x.at).toLocaleString('ko-KR'), x.name, fmtPhone(x.phone), x.branch_name, PLAN_LABEL[x.plan] || x.plan, x.days, x.amount, x.payer, x.memo, fmtDate(x.prior), fmtDate(x.until), x.operator].map(q).join(',');
    })).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'DUO_매출_' + state.revMonth + (state.branch !== 'all' ? '_' + state.branch : '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  };
  DUOA.openCreate = function () {
    var br = (me.branches || []).map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + '</option>'; }).join('');
    openDialog('DUO 기사 직접 추가',
      '<div class="alert a-blue">직접 추가한 기사는 <b>바로 승인</b> 상태입니다. 이용권은 따로 부여하세요.</div>' +
      '<div class="fg"><label class="fl">실명 *</label><input class="fi2" id="duo-c-name" placeholder="홍길동"></div>' +
      '<div class="fg"><label class="fl">휴대폰 *</label><input class="fi2" id="duo-c-phone" inputmode="numeric" placeholder="01012345678"></div>' +
      '<div class="fg"><label class="fl">지점 *</label><select class="fi2" id="duo-c-branch"><option value="">지점 선택...</option>' + br + '</select></div>' +
      '<div class="fg"><label class="fl">차종</label><select class="fi2" id="duo-c-veh"><option value="">선택 안 함</option>' + VEHICLES.map(function (v) { return '<option>' + v + '</option>'; }).join('') + '</select></div>' +
      '<div class="fg" style="margin:0"><label class="fl">초기 비밀번호 * (숫자 6자리 이상)</label><input class="fi2" id="duo-c-pw" type="password" inputmode="numeric"><div class="fd">기사에게 직접 전달하세요. 저장·조회되지 않습니다.</div></div>',
      '추가', function () {
        api({ action: 'create_member', name: document.getElementById('duo-c-name').value.trim(), phone: document.getElementById('duo-c-phone').value,
          branch_id: parseInt(document.getElementById('duo-c-branch').value, 10) || null, vehicle: document.getElementById('duo-c-veh').value || null,
          password: document.getElementById('duo-c-pw').value }).then(function (j) {
          if (after(j, '기사를 추가했습니다')) { state.tab = 'members'; state.filter = 'active'; load(); }
        });
      });
  };
  function grantFrom(id) {
    var g = {};
    FLAGS.forEach(function (f) { var c = document.getElementById('dg-' + id + '-' + f[0]); g[f[0]] = !!(c && c.checked); });
    g.scope = (document.getElementById('dg-' + id + '-scope') || {}).value || 'own';
    return g;
  }
  DUOA.saveGrant = function (id) {
    api({ action: 'set_grant', target_admin_id: id, grant: grantFrom(id) }).then(function (j) { if (!j.ok) return fail(j); toast('권한을 저장했습니다', 'success'); loadGrants(); });
  };
  DUOA.revokeGrant = function (id) {
    if (!confirm('이 관리자의 DUO 권한을 모두 회수할까요?')) return;
    api({ action: 'set_grant', target_admin_id: id, grant: null }).then(function (j) { if (!j.ok) return fail(j); toast('권한을 회수했습니다', 'success'); loadGrants(); });
  };

  window.renderDuo = function () {
    setTimeout(function () { if (!root()) return; draw(); if (me && me.grant) load(); }, 0);
    return '<div id="duo-root"></div>';
  };
})();
