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
  var state = { tab: 'pending', filter: 'approved', branch: 'all', q: '', list: [], loading: false, err: '', grants: null, rev: null, revMonth: '' };
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
    var st = state.tab === 'pending' ? 'pending' : state.filter;
    return api({ action: 'members', status: st }).then(function (j) {
      state.loading = false;
      if (!j.ok) { state.err = j.message || '불러오기 실패'; state.list = []; }
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
  function load() {
    if (state.tab === 'grants') return loadGrants();
    if (state.tab === 'revenue') return loadRevenue();
    return loadMembers();
  }

  // ---------- 화면 ----------
  function tabs() {
    var g = me.grant, t = [['pending', '⏳ 승인 대기'], ['members', '👥 회원']];
    if (g.delegate) t.push(['grants', '🔑 관리자 권한']);
    if (g.revenue) t.push(['revenue', '💰 매출']);
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
    if (m.status === 'suspended' && g.approve) b.push('<button class="btn btn-s btn-sm" onclick="DUOA.setStatus(' + m.id + ',\'approved\')">재개</button>');
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
      h += '<div class="fbar">' + [['approved', '승인'], ['suspended', '정지'], ['rejected', '반려'], ['all', '전체']].map(function (x) {
        return '<button class="fbtn' + (state.filter === x[0] ? ' on' : '') + '" onclick="DUOA.filter(\'' + x[0] + '\')">' + x[1] + '</button>';
      }).join('') + '</div>';
    }
    var q = state.q.trim(), list = state.list.filter(function (m) { return inBranch(m) && (!q || (m.name || '').indexOf(q) >= 0 || digits(m.phone).indexOf(digits(q) || '\u0000') >= 0); });
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

  function draw() {
    var r = root(); if (!r) return;
    if (!me || !me.grant) {
      r.innerHTML = '<div class="empty"><div class="empty-icon">🔒</div><div class="empty-txt">DUO 관리자 세션이 없습니다.<br>로그아웃 후 다시 로그인하면 연결됩니다.</div></div>';
      return;
    }
    var body = state.loading ? '<div class="empty"><div class="empty-txt"><span class="loading"></span> 불러오는 중...</div></div>'
      : state.err ? '<div class="alert a-red">' + esc(state.err) + '</div>'
      : state.tab === 'grants' ? grantsHtml() : state.tab === 'revenue' ? revenueHtml() : membersHtml();
    r.innerHTML = header() + tabs() + body;
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
  DUOA.close = function () { var m = document.getElementById('duo-dialog'); if (m) m.classList.remove('open'); dlg = null; };
  DUOA.submit = function () { if (!dlg) return; var b = document.getElementById('duo-d-ok'); if (b) b.disabled = true; dlg.ok(); };
  function find(id) { return state.list.filter(function (m) { return m.id === id; })[0] || {}; }
  function after(j, okMsg) {
    if (!j.ok) { dlgErr(j.message || '실패했습니다.'); toast(j.message || '실패', 'error'); return false; }
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
    api({ action: 'review', member_id: id, approve: true }).then(function (j) { if (!j.ok) return toast(j.message, 'error'); toast('승인했습니다', 'success'); load(); });
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
      if (!confirm((m.name || '') + ' 님의 정지를 해제할까요?')) return;
      api({ action: 'set_status', member_id: id, status: 'approved' }).then(function (j) { if (!j.ok) return toast(j.message, 'error'); toast('재개했습니다', 'success'); load(); });
    }
  };
  DUOA.dual = function (id, approve) {
    var m = find(id);
    if (!confirm((m.name || '') + (approve ? ' 님을 듀얼 이용자로 승인할까요?' : ' 님의 듀얼 승인을 해제할까요?'))) return;
    api({ action: 'dual', member_id: id, approve: approve }).then(function (j) { if (!j.ok) return toast(j.message, 'error'); toast(approve ? '듀얼 승인했습니다' : '듀얼 해제했습니다', 'success'); load(); });
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
          if (after(j, '기사를 추가했습니다')) { state.tab = 'members'; state.filter = 'approved'; load(); }
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
    api({ action: 'set_grant', target_admin_id: id, grant: grantFrom(id) }).then(function (j) { if (!j.ok) return toast(j.message, 'error'); toast('권한을 저장했습니다', 'success'); loadGrants(); });
  };
  DUOA.revokeGrant = function (id) {
    if (!confirm('이 관리자의 DUO 권한을 모두 회수할까요?')) return;
    api({ action: 'set_grant', target_admin_id: id, grant: null }).then(function (j) { if (!j.ok) return toast(j.message, 'error'); toast('권한을 회수했습니다', 'success'); loadGrants(); });
  };

  window.renderDuo = function () {
    setTimeout(function () { if (!root()) return; draw(); if (me && me.grant) load(); }, 0);
    return '<div id="duo-root"></div>';
  };
})();
