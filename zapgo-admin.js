/* =====================================================================
 * zapgo-admin.js — QUICK ADMIN 부가 모듈: "잡고 관리" (잡고 전용)
 *
 *  - 토스/그랩 화면·DB(Supabase)와 완전히 분리. 잡고 서버(zapgo-api)와만 통신한다.
 *  - 자체 로그인: zapgo-api 관리자 계정(서버에서 비밀번호 검증) → 토큰은 탭을
 *    닫으면 사라지는 sessionStorage 에만 보관. 비밀번호는 어디에도 저장하지 않는다.
 *  - 어드민 로그인 시 같은 비밀번호면 자동 연결(ZG.autoLogin), 다르면 직접 로그인.
 *
 *  탭: 대시보드 / 회원 관리 / 이용권 관리 / 멀티 번호
 *  (결제 관리·매출은 서버에 금액 정보가 생긴 뒤 추가)
 *
 *  index.html 연결(5곳): 메뉴 항목 / navigate 표(zapgo) / 이 스크립트 태그 /
 *                        doLogin 의 autoLogin 호출 / doLogout 의 clearSession 호출
 * ===================================================================== */
(function () {
  'use strict';

  var API = 'https://64-176-231-115.sslip.io/api';
  var TOKEN_KEY = 'zapgo_admin_token';
  var LINK_KEY = 'zapgo_admin_link'; // 어드민 아이디 ↔ 잡고 관리자 아이디 연결(비밀번호는 저장하지 않음)
  var MAX_EXTRA = 4;
  var PHONE_RE = /^01[016789]\d{7,8}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var STATUS = {
    approved: ['승인', 'ok'],
    pending: ['대기', 'wait'],
    suspended: ['정지', 'stop'],
    rejected: ['거절', 'stop']
  };
  var TABS = [
    ['dash', '📊 대시보드'],
    ['members', '👥 회원 관리'],
    ['license', '🎫 이용권 관리'],
    ['phones', '📱 멀티 번호']
  ];

  var state = { all: [], loaded: false, tab: 'dash', q: '', status: '', lic: 'soon' };
  var edit = null; // 번호 편집 모달 상태
  var dlg = null;  // 승인/연장 다이얼로그 상태

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function digits(v) { return String(v || '').replace(/\D/g, ''); }
  function fmtPhone(v) {
    var d = digits(v);
    if (d.length === 11) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
    if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
    return d;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    try { return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); } catch (e) { return String(iso).slice(0, 10); }
  }
  function todayKST() { return fmtDate(new Date().toISOString()); }
  function addDays(ymd, n) {
    var d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayDiff(fromYmd, toYmd) {
    return Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);
  }
  function expYmd(r) {
    var v = fmtDate(r.membershipExpiresAt);
    return v === '—' ? null : v;
  }
  // 만료까지 남은 일수 (오늘 = 0, 지났으면 음수, 만료일 없으면 null)
  function dday(r) {
    var e = expYmd(r);
    return e ? dayDiff(todayKST(), e) : null;
  }
  function ddayBadge(r) {
    var d = dday(r);
    if (d === null) return '<span class="zg-pill wait">기간 없음</span>';
    if (d < 0) return '<span class="zg-pill stop">만료 ' + (-d) + '일 지남</span>';
    if (d === 0) return '<span class="zg-pill stop">오늘 만료</span>';
    if (d <= 3) return '<span class="zg-pill stop">D-' + d + '</span>';
    if (d <= 7) return '<span class="zg-pill wait">D-' + d + '</span>';
    return '<span class="zg-pill ok">D-' + d + '</span>';
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else window.alert(msg);
  }
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) {
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* 무시 */ }
  }
  function getLink() {
    try {
      var v = JSON.parse(localStorage.getItem(LINK_KEY) || 'null');
      return v && v.q && v.z ? v : null;
    } catch (e) { return null; }
  }
  function setLink(zapId) {
    try {
      var q = window.user && window.user.id;
      if (q && zapId) localStorage.setItem(LINK_KEY, JSON.stringify({ q: q, z: zapId }));
    } catch (e) { /* 무시 */ }
  }
  function clearLink() { try { localStorage.removeItem(LINK_KEY); } catch (e) { /* 무시 */ } }
  function root() { return document.getElementById('zg-root'); }
  function byId(id) { return state.all.filter(function (x) { return x.id === id; })[0]; }

  function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var t = getToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    return fetch(API + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = new Error(j.error || ('요청 실패 (HTTP ' + r.status + ')'));
          e.status = r.status;
          e.code = j.code;
          throw e;
        }
        return j;
      });
    });
  }

  function handleErr(e) {
    if (e && e.status === 401) {
      setToken(null);
      closeModal();
      closeDialog();
      drawLogin('세션이 만료되었습니다. 다시 로그인해 주세요.');
      return;
    }
    toast((e && e.message) || '오류가 발생했습니다', 'error');
  }

  // ---------- 스타일 ----------
  function injectStyle() {
    if (document.getElementById('zg-style')) return;
    var st = document.createElement('style');
    st.id = 'zg-style';
    st.textContent =
      '.zg-wrap{max-width:1000px}' +
      '.zg-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}' +
      '.zg-title{font-size:18px;font-weight:700}' +
      '.zg-sub{font-size:12px;color:var(--text3);margin-bottom:14px;line-height:1.6}' +
      '.zg-tabs{display:flex;gap:4px;flex-wrap:wrap;margin:12px 0 16px;border-bottom:1px solid var(--border)}' +
      '.zg-tab{padding:9px 13px;font-size:12px;font-weight:600;color:var(--text3);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}' +
      '.zg-tab.on{color:var(--accent);border-bottom-color:var(--accent)}' +
      '.zg-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}' +
      '.zg-stat{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer}' +
      '.zg-stat .l{font-size:11px;color:var(--text3)}' +
      '.zg-stat b{display:block;font-size:24px;margin-top:6px}' +
      '.zg-stat.warn b{color:var(--accent)}.zg-stat.bad b{color:var(--red)}.zg-stat.good b{color:var(--green)}' +
      '.zg-sec{font-size:13px;font-weight:700;margin:16px 0 8px}' +
      '.zg-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}' +
      '.zg-bar input,.zg-bar select{background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:8px 10px;color:var(--text);font-size:12px;outline:none}' +
      '.zg-bar input{flex:1;min-width:160px}' +
      '.zg-chip{padding:6px 11px;border-radius:14px;border:1px solid var(--border);font-size:11px;color:var(--text2);cursor:pointer;background:var(--bg3)}' +
      '.zg-chip.on{border-color:var(--accent);color:var(--accent)}' +
      '.zg-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;background:var(--bg3);border:1px solid var(--border);border-radius:9px;margin-bottom:7px;flex-wrap:wrap}' +
      '.zg-main{min-width:0;flex:1}' +
      '.zg-name{font-size:13px;font-weight:600}' +
      '.zg-meta{font-size:11px;color:var(--text3);margin-top:3px;font-family:monospace}' +
      '.zg-acts{display:flex;gap:6px;flex-wrap:wrap}' +
      '.zg-pill{font-size:10px;font-weight:600;padding:2px 7px;border-radius:9px;margin-left:6px}' +
      '.zg-pill.ok{color:var(--green);background:rgba(46,204,113,.15)}' +
      '.zg-pill.wait{color:var(--accent);background:rgba(240,180,41,.15)}' +
      '.zg-pill.stop{color:var(--red);background:rgba(231,76,60,.15)}' +
      '.zg-card{background:var(--bg3);border:1px solid var(--border);border-radius:11px;padding:20px;max-width:360px}' +
      '.zg-slot{display:flex;align-items:center;gap:8px;padding:9px 10px;background:var(--bg3);border-radius:7px;margin-bottom:6px;flex-wrap:wrap}' +
      '.zg-slotno{width:24px;height:24px;border-radius:5px;background:var(--bg5,#2a3247);color:var(--text2);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}' +
      '.zg-slotno.main{background:var(--accent);color:#000}' +
      '.zg-in{background:var(--bg4);border:1px solid var(--border);border-radius:5px;padding:6px 8px;color:var(--text);font-size:12px;outline:none;min-width:0}' +
      '.zg-in.phone{width:150px;font-family:monospace}' +
      '.zg-in.label{width:110px}' +
      '.zg-in.bad{border-color:var(--red)}' +
      '.zg-err{color:var(--red);font-size:12px;margin-top:8px;min-height:16px}' +
      '.zg-empty{padding:26px;text-align:center;color:var(--text3);font-size:12px}' +
      '.zg-note{font-size:11px;color:var(--text3);line-height:1.6;margin:8px 0}' +
      '.zg-presets{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 8px}';
    document.head.appendChild(st);
  }

  // ---------- 화면: 로그인 ----------
  function drawLogin(msg) {
    var el = root();
    if (!el) return;
    el.innerHTML =
      '<div class="zg-wrap">' +
      '<div class="zg-title" style="margin-bottom:6px">🛵 잡고 관리</div>' +
      '<div class="zg-sub">잡고 서버 관리자 계정으로 로그인해 주세요. 한 번 로그인하면 이후에는 이 어드민에 로그인할 때 ' +
      '<b>같은 비밀번호로 자동 연결</b>됩니다. (비밀번호가 다르면 이 화면에서 직접 로그인)</div>' +
      '<div class="zg-card">' +
      '<div class="fg"><label class="fl">아이디</label><input class="fi2" id="zg-id" autocomplete="username" onkeydown="if(event.key===\'Enter\')document.getElementById(\'zg-pw\').focus()"></div>' +
      '<div class="fg"><label class="fl">비밀번호</label><input class="fi2" id="zg-pw" type="password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')ZG.login()"></div>' +
      '<div class="zg-err" id="zg-login-err">' + esc(msg || '') + '</div>' +
      '<button class="btn btn-p" id="zg-login-btn" style="width:100%;margin-top:6px" onclick="ZG.login()">로그인</button>' +
      '</div></div>';
  }

  // ---------- 화면: 껍데기(제목/탭) ----------
  function drawShell() {
    var el = root();
    if (!el) return;
    el.innerHTML =
      '<div class="zg-wrap">' +
      '<div class="zg-head"><div class="zg-title">🛵 잡고 관리</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
      (getLink() ? '<span style="font-size:11px;color:var(--green)">✓ 어드민 로그인과 연결됨</span>' +
        '<button class="btn btn-g btn-sm" onclick="ZG.unlink()">연결 해제</button>' : '') +
      '<button class="btn btn-g btn-sm" onclick="ZG.refresh()">↻ 새로고침</button>' +
      '<button class="btn btn-g btn-sm" onclick="ZG.logout()">잡고 로그아웃</button></div></div>' +
      '<div class="zg-tabs" id="zg-tabs"></div>' +
      '<div id="zg-content"><div class="zg-empty">불러오는 중…</div></div></div>';
    drawTabs();
  }
  function drawTabs() {
    var box = document.getElementById('zg-tabs');
    if (!box) return;
    box.innerHTML = TABS.map(function (t) {
      return '<div class="zg-tab' + (state.tab === t[0] ? ' on' : '') + '" data-t="' + t[0] + '" onclick="ZG.tab(this.dataset.t)">' + t[1] + '</div>';
    }).join('');
  }

  function loadAll() {
    if (!getToken()) { drawLogin(); return; }
    if (!document.getElementById('zg-content')) drawShell();
    api('GET', '/admin/users')
      .then(function (list) {
        state.all = Array.isArray(list) ? list : [];
        state.loaded = true;
        drawContent();
      })
      .catch(function (e) {
        var box = document.getElementById('zg-content');
        if (box) box.innerHTML = '<div class="zg-empty">불러오지 못했습니다: ' + esc(e.message) + '</div>';
        handleErr(e);
      });
  }

  function drawContent() {
    var box = document.getElementById('zg-content');
    if (!box) return;
    drawTabs();
    if (!state.loaded) { box.innerHTML = '<div class="zg-empty">불러오는 중…</div>'; return; }
    if (state.tab === 'dash') { box.innerHTML = dashHtml(); return; }
    if (state.tab === 'license') {
      box.innerHTML = licenseBarHtml() + '<div id="zg-rows"></div>';
    } else {
      box.innerHTML = memberBarHtml() + '<div id="zg-rows"></div>';
    }
    drawRows();
  }

  // ---------- 탭: 대시보드 ----------
  function counts() {
    var c = { all: 0, approved: 0, pending: 0, suspended: 0, rejected: 0, expired: 0, soon3: 0, soon7: 0 };
    state.all.forEach(function (r) {
      c.all++;
      if (c[r.status] !== undefined) c[r.status]++;
      if (r.status === 'approved') {
        var d = dday(r);
        if (d !== null) {
          if (d < 0) c.expired++;
          else { if (d <= 3) c.soon3++; if (d <= 7) c.soon7++; }
        }
      }
    });
    return c;
  }
  function miniRow(r, kind) {
    var act = kind === 'pending'
      ? '<button class="btn btn-p btn-sm" data-id="' + esc(r.id) + '" onclick="ZG.act(\'approve\',this.dataset.id)">승인</button>'
      : '<button class="btn btn-p btn-sm" data-id="' + esc(r.id) + '" onclick="ZG.act(\'extend\',this.dataset.id)">기간 연장</button>';
    return '<div class="zg-row"><div class="zg-main"><div class="zg-name">' + esc(r.name || '(이름 없음)') +
      (kind === 'pending' ? '' : ddayBadge(r)) + '</div>' +
      '<div class="zg-meta">📞 ' + esc(fmtPhone(r.phone)) + (kind === 'pending' ? ' · 가입 ' + esc(fmtDate(r.createdAt)) : ' · 만료 ' + esc(expYmd(r) || '—')) + '</div></div>' + act + '</div>';
  }
  function dashHtml() {
    var c = counts();
    var pend = state.all.filter(function (r) { return r.status === 'pending'; }).slice(0, 5);
    var soon = state.all.filter(function (r) {
      var d = dday(r); return r.status === 'approved' && d !== null && d >= 0 && d <= 7;
    }).sort(function (a, b) { return dday(a) - dday(b); }).slice(0, 5);
    function stat(label, val, cls, go) {
      return '<div class="zg-stat ' + cls + '" data-go="' + go + '" onclick="ZG.go(this.dataset.go)"><div class="l">' + label + '</div><b>' + val + '</b></div>';
    }
    return '<div class="zg-cards">' +
      stat('전체 회원', c.all, '', 'members:') +
      stat('승인 (이용 중)', c.approved, 'good', 'members:approved') +
      stat('승인 대기', c.pending, c.pending ? 'warn' : '', 'members:pending') +
      stat('정지', c.suspended, '', 'members:suspended') +
      stat('3일 내 만료', c.soon3, c.soon3 ? 'warn' : '', 'license:3') +
      stat('만료됨', c.expired, c.expired ? 'bad' : '', 'license:expired') + '</div>' +
      '<div class="zg-sec">승인 대기 (' + c.pending + ')</div>' +
      (pend.length ? pend.map(function (r) { return miniRow(r, 'pending'); }).join('') : '<div class="zg-empty">대기 중인 가입 요청이 없습니다</div>') +
      '<div class="zg-sec">만료 임박 · 7일 이내 (' + c.soon7 + ')</div>' +
      (soon.length ? soon.map(function (r) { return miniRow(r, 'soon'); }).join('') : '<div class="zg-empty">7일 이내 만료되는 회원이 없습니다</div>') +
      '<div class="zg-note">결제 관리와 매출은 서버에 결제 금액 정보가 생긴 뒤 추가됩니다.</div>';
  }

  // ---------- 탭: 회원 관리 / 멀티 번호 ----------
  function memberBarHtml() {
    return '<div class="zg-bar">' +
      '<input id="zg-q" placeholder="이름 / 아이디 / 번호 검색" value="' + esc(state.q) + '" oninput="ZG.setQ(this.value)">' +
      '<select id="zg-status" onchange="ZG.setStatus(this.value)">' +
      ['', 'approved', 'pending', 'suspended', 'rejected'].map(function (v) {
        var label = v ? STATUS[v][0] : '전체 상태';
        return '<option value="' + v + '"' + (state.status === v ? ' selected' : '') + '>' + label + '</option>';
      }).join('') + '</select></div>' +
      (state.tab === 'phones' ? '<div class="zg-sub">기사 1명당 <b>메인 번호 1개 + 추가 번호 최대 ' + MAX_EXTRA + '개</b>(총 5개). ' +
        '추가 번호는 관리자만 설정하고, 기사는 앱에서 등록된 번호끼리 전환만 합니다. ' +
        '반드시 <b>기사 본인이 사용하는 번호</b>만 등록하세요.</div>' : '');
  }
  function matchQ(r) {
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    var qd = digits(state.q);
    return String(r.name || '').toLowerCase().indexOf(q) >= 0 ||
      String(r.username || '').toLowerCase().indexOf(q) >= 0 ||
      (qd && digits(r.phone).indexOf(qd) >= 0);
  }
  function nameHtml(r) {
    var st = STATUS[r.status] || [r.status || '—', 'wait'];
    return '<div class="zg-name">' + esc(r.name || '(이름 없음)') +
      (r.username ? ' <span style="font-weight:400;color:var(--text3)">@' + esc(r.username) + '</span>' : '') +
      '<span class="zg-pill ' + st[1] + '">' + esc(st[0]) + '</span></div>';
  }
  function btn(label, cls, act, id) {
    return '<button class="btn ' + cls + ' btn-sm" data-id="' + esc(id) + '" onclick="ZG.act(\'' + act + '\',this.dataset.id)">' + label + '</button>';
  }
  function memberRow(r) {
    var acts = '';
    if (r.status === 'pending') acts = btn('승인', 'btn-p', 'approve', r.id) + btn('거절', 'btn-d', 'reject', r.id);
    else if (r.status === 'approved') acts = btn('기간 연장', 'btn-p', 'extend', r.id) + btn('정지', 'btn-d', 'suspend', r.id) + btn('📱 번호', 'btn-g', 'phones', r.id);
    else if (r.status === 'suspended') acts = btn('정지 해제', 'btn-p', 'unsuspend', r.id) + btn('📱 번호', 'btn-g', 'phones', r.id);
    return '<div class="zg-row"><div class="zg-main">' + nameHtml(r) +
      '<div class="zg-meta">📞 ' + esc(fmtPhone(r.phone)) + ' · 가입 ' + esc(fmtDate(r.createdAt)) +
      ' · 만료 ' + esc(expYmd(r) || '—') + '</div></div><div class="zg-acts">' + acts + '</div></div>';
  }
  function phoneRow(r) {
    return '<div class="zg-row"><div class="zg-main">' + nameHtml(r) +
      '<div class="zg-meta">📞 ' + esc(fmtPhone(r.phone)) + ' · 만료 ' + esc(fmtDate(r.membershipExpiresAt)) + '</div></div>' +
      '<div class="zg-acts">' + btn('📱 번호 관리', 'btn-p', 'phones', r.id) + '</div></div>';
  }

  // ---------- 탭: 이용권 관리 ----------
  var LIC = [['soon', '7일 이내'], ['3', '3일 이내'], ['30', '30일 이내'], ['expired', '만료됨'], ['all', '전체']];
  function licenseBarHtml() {
    return '<div class="zg-bar">' +
      LIC.map(function (l) {
        return '<div class="zg-chip' + (state.lic === l[0] ? ' on' : '') + '" data-k="' + l[0] + '" onclick="ZG.setLic(this.dataset.k)">' + l[1] + '</div>';
      }).join('') + '</div>' +
      '<div class="zg-bar"><input id="zg-q" placeholder="이름 / 아이디 / 번호 검색" value="' + esc(state.q) + '" oninput="ZG.setQ(this.value)"></div>' +
      '<div class="zg-sub">승인된 회원만 표시합니다. 만료가 가까운 순서입니다.</div>';
  }
  function licenseList() {
    return state.all.filter(function (r) {
      if (r.status !== 'approved' || !matchQ(r)) return false;
      var d = dday(r);
      if (state.lic === 'all') return true;
      if (d === null) return false;
      if (state.lic === 'expired') return d < 0;
      var n = state.lic === 'soon' ? 7 : parseInt(state.lic, 10);
      return d >= 0 && d <= n;
    }).sort(function (a, b) {
      var x = dday(a), y = dday(b);
      return (x === null ? 1e9 : x) - (y === null ? 1e9 : y);
    });
  }
  function licenseRow(r) {
    return '<div class="zg-row"><div class="zg-main"><div class="zg-name">' + esc(r.name || '(이름 없음)') +
      (r.username ? ' <span style="font-weight:400;color:var(--text3)">@' + esc(r.username) + '</span>' : '') + ddayBadge(r) + '</div>' +
      '<div class="zg-meta">📞 ' + esc(fmtPhone(r.phone)) + ' · 만료 ' + esc(expYmd(r) || '—') + '</div></div>' +
      '<div class="zg-acts">' + btn('기간 연장', 'btn-p', 'extend', r.id) + '</div></div>';
  }

  function drawRows() {
    var box = document.getElementById('zg-rows');
    if (!box) return;
    var list, fn;
    if (state.tab === 'license') { list = licenseList(); fn = licenseRow; }
    else {
      list = state.all.filter(function (r) { return (!state.status || r.status === state.status) && matchQ(r); });
      fn = state.tab === 'phones' ? phoneRow : memberRow;
    }
    box.innerHTML = list.length ? list.map(fn).join('') : '<div class="zg-empty">표시할 회원이 없습니다</div>';
  }

  // ---------- 다이얼로그: 승인 / 연장 ----------
  function dialogEl() {
    var m = document.getElementById('zg-dialog');
    if (!m) {
      m = document.createElement('div');
      m.id = 'zg-dialog';
      m.className = 'modal-bg';
      document.body.appendChild(m);
    }
    return m;
  }
  function closeDialog() {
    var m = document.getElementById('zg-dialog');
    if (m) m.classList.remove('open');
    dlg = null;
  }
  function presetsHtml() {
    return '<div class="zg-presets">' + [30, 90, 180, 365].map(function (n) {
      return '<button class="btn btn-g btn-sm" onclick="ZG.preset(' + n + ')">+' + n + '일</button>';
    }).join('') + '</div>';
  }
  function drawDialog() {
    if (!dlg) return;
    var isApprove = dlg.kind === 'approve';
    var m = dialogEl();
    m.innerHTML =
      '<div class="modal-box" style="max-width:420px">' +
      '<div class="mh"><div class="mt">' + (isApprove ? '✅ 가입 승인' : '🎫 기간 연장') + ' — ' + esc(dlg.name) + '</div>' +
      '<button class="mc" onclick="ZG.dlgClose()">×</button></div>' +
      (isApprove
        ? '<div class="zg-note">승인하면 기사는 아래 기간 동안 잡고를 이용할 수 있습니다.</div>' +
          '<div class="fg"><label class="fl">시작일</label><input class="fi2" type="date" id="zg-d-start" value="' + esc(dlg.start) + '"></div>'
        : '<div class="zg-note">현재 만료일: <b>' + esc(dlg.current || '—') + '</b> · 연장 기준일(현재 만료일과 오늘 중 늦은 날): <b>' + esc(dlg.base) + '</b></div>') +
      '<div class="fg"><label class="fl">' + (isApprove ? '종료일' : '새 만료일') + '</label><input class="fi2" type="date" id="zg-d-end" value="' + esc(dlg.end) + '"></div>' +
      presetsHtml() +
      '<div class="zg-err" id="zg-d-err">' + esc(dlg.err || '') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">' +
      '<button class="btn btn-g" onclick="ZG.dlgClose()">취소</button>' +
      '<button class="btn btn-p" id="zg-d-ok" onclick="ZG.dlgSubmit()">' + (isApprove ? '승인' : '연장') + '</button></div></div>';
    m.classList.add('open');
  }

  // ---------- 번호 편집 모달 ----------
  function modalEl() {
    var m = document.getElementById('zg-modal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'zg-modal';
      m.className = 'modal-bg';
      document.body.appendChild(m);
    }
    return m;
  }
  function closeModal() {
    var m = document.getElementById('zg-modal');
    if (m) m.classList.remove('open');
    edit = null;
  }

  function drawModal() {
    if (!edit) return;
    var m = modalEl();
    var rowsHtml = edit.rows.map(function (r, i) {
      return '<div class="zg-slot" style="opacity:' + (r.isActive ? 1 : 0.55) + '">' +
        '<div class="zg-slotno">' + r.slot + '</div>' +
        '<input class="zg-in phone" placeholder="010-0000-0000" inputmode="numeric" value="' + esc(r.phone) + '" data-i="' + i + '" data-f="phone" oninput="ZG.onField(this)">' +
        '<input class="zg-in label" placeholder="별칭 (예: 2호기)" maxlength="20" value="' + esc(r.label) + '" data-i="' + i + '" data-f="label" oninput="ZG.onField(this)">' +
        '<label style="font-size:11px;color:var(--text2);display:flex;align-items:center;gap:4px">' +
        '<input type="checkbox" ' + (r.isActive ? 'checked' : '') + ' data-i="' + i + '" data-f="isActive" onchange="ZG.onField(this)"> 사용</label>' +
        '<button class="btn btn-d btn-sm" style="margin-left:auto" onclick="ZG.delRow(' + i + ')">삭제</button></div>';
    }).join('');

    m.innerHTML =
      '<div class="modal-box" style="max-width:560px">' +
      '<div class="mh"><div class="mt">📱 ' + esc(edit.name) + ' 번호 관리</div>' +
      '<button class="mc" onclick="ZG.closeEditor()">×</button></div>' +
      '<div class="zg-note">메인 번호는 기사 계정의 번호라서 여기서 바꿀 수 없습니다. ' +
      '번호를 삭제하거나 사용을 끄면 그 번호로 접속 중인 기사는 잠시 후 연결이 끊깁니다.</div>' +
      '<div class="zg-slot"><div class="zg-slotno main">1</div>' +
      '<div style="font-family:monospace;font-size:12px;color:var(--accent)">' + esc(fmtPhone(edit.main)) + '</div>' +
      '<span style="font-size:9px;color:var(--accent);background:rgba(240,180,41,.15);padding:1px 5px;border-radius:3px">메인</span></div>' +
      rowsHtml +
      '<div style="margin:8px 0"><button class="btn btn-g btn-sm" id="zg-add" onclick="ZG.addRow()"' +
      (edit.rows.length >= MAX_EXTRA ? ' disabled' : '') + '>＋ 번호 추가 (' + edit.rows.length + '/' + MAX_EXTRA + ')</button></div>' +
      '<div class="zg-err" id="zg-edit-err">' + esc(edit.err || '') + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:10px">' +
      '<span id="zg-dirty" style="font-size:11px;color:var(--accent);display:' + (edit.dirty ? 'inline' : 'none') + '">⏳ 미저장 변경사항</span>' +
      '<div style="margin-left:auto;display:flex;gap:8px">' +
      '<button class="btn btn-g" onclick="ZG.closeEditor()">취소 / 닫기</button>' +
      '<button class="btn btn-p" id="zg-save" onclick="ZG.save()"' + ((edit.dirty && !edit.saving) ? '' : ' disabled') + '>' +
      (edit.saving ? '저장 중…' : '💾 저장') + '</button></div></div></div>';
    m.classList.add('open');
  }

  function refreshSaveState() {
    var b = document.getElementById('zg-save');
    var d = document.getElementById('zg-dirty');
    if (b) b.disabled = !(edit && edit.dirty && !edit.saving);
    if (d) d.style.display = (edit && edit.dirty) ? 'inline' : 'none';
  }

  function validateEdit() {
    var seen = {};
    seen[digits(edit.main)] = true;
    for (var i = 0; i < edit.rows.length; i++) {
      var d = digits(edit.rows[i].phone);
      if (!PHONE_RE.test(d)) return '슬롯 ' + edit.rows[i].slot + ': 휴대폰 번호 형식이 올바르지 않습니다.';
      if (seen[d]) return '슬롯 ' + edit.rows[i].slot + ': 메인 번호 또는 다른 슬롯과 중복됩니다.';
      seen[d] = true;
    }
    return null;
  }

  // ---------- 외부 노출(인라인 핸들러용) ----------
  var ZG = window.ZG = {};

  ZG.login = function () {
    var id = (document.getElementById('zg-id') || {}).value || '';
    var pw = (document.getElementById('zg-pw') || {}).value || '';
    var err = document.getElementById('zg-login-err');
    var btnEl = document.getElementById('zg-login-btn');
    if (!id.trim() || !pw) { if (err) err.textContent = '아이디와 비밀번호를 입력하세요'; return; }
    if (btnEl) btnEl.disabled = true;
    api('POST', '/admin/login', { username: id.trim(), password: pw })
      .then(function (res) {
        if (!res || !res.token) throw new Error('로그인 응답이 올바르지 않습니다');
        setToken(res.token);
        setLink(id.trim());
        drawShell();
        loadAll();
      })
      .catch(function (e) {
        if (btnEl) btnEl.disabled = false;
        var pwEl = document.getElementById('zg-pw');
        if (pwEl) pwEl.value = '';
        if (err) err.textContent = e.status === 401 ? '아이디 또는 비밀번호가 올바르지 않습니다' : (e.message || '로그인에 실패했습니다');
      });
  };

  // 어드민 로그인 직후 index.html 이 호출: 연결된 어드민 아이디일 때만, 방금 입력한 비밀번호로
  // 잡고 서버에 조용히 로그인한다. 실패하면 아무 표시 없이 넘어가고 잡고 탭에서 직접 로그인하면 된다.
  // 비밀번호는 이 함수 안에서만 쓰이고 어디에도 저장하지 않는다.
  ZG.autoLogin = function (quickId, pw) {
    var link = getLink();
    if (!link || !quickId || !pw || link.q !== quickId) return;
    api('POST', '/admin/login', { username: link.z, password: pw })
      .then(function (res) { if (res && res.token) setToken(res.token); })
      .catch(function () { /* 조용히 실패 */ });
  };
  // 어드민 로그아웃 시 호출: 잡고 세션도 함께 종료
  ZG.clearSession = function () {
    setToken(null);
    state.all = [];
    state.loaded = false;
    closeModal();
    closeDialog();
  };
  ZG.unlink = function () { clearLink(); drawShell(); drawContent(); };
  ZG.logout = function () { ZG.clearSession(); drawLogin(); };
  ZG.refresh = function () { loadAll(); };

  // 탭을 직접 누르면 검색·필터를 초기화한다 (대시보드 카드로 들어온 필터가 남지 않게)
  ZG.tab = function (t) {
    state.tab = t;
    state.q = '';
    state.status = '';
    state.lic = 'soon';
    drawContent();
  };
  // 대시보드 카드 클릭: "탭:값"
  ZG.go = function (spec) {
    var p = String(spec).split(':');
    state.q = '';
    if (p[0] === 'members') { state.tab = 'members'; state.status = p[1] || ''; }
    else if (p[0] === 'license') { state.tab = 'license'; state.lic = p[1] || 'soon'; }
    drawContent();
  };
  ZG.setQ = function (v) { state.q = v || ''; drawRows(); };
  ZG.setStatus = function (v) { state.status = v || ''; drawRows(); };
  ZG.setLic = function (k) { state.lic = k; drawContent(); };

  // 회원 처리: approve / extend / reject / suspend / unsuspend / phones
  ZG.act = function (kind, id) {
    var r = byId(id);
    if (!r) return;
    if (kind === 'phones') { ZG.openEditor(id); return; }
    if (kind === 'approve') {
      var t = todayKST();
      dlg = { kind: 'approve', id: id, name: r.name || '', start: t, end: addDays(t, 30), err: '' };
      drawDialog();
      return;
    }
    if (kind === 'extend') {
      var today = todayKST();
      var cur = expYmd(r);
      var base = cur && cur > today ? cur : today;
      dlg = { kind: 'extend', id: id, name: r.name || '', current: cur, base: base, end: addDays(base, 30), err: '' };
      drawDialog();
      return;
    }
    var label = { reject: '가입을 거절', suspend: '이용을 정지', unsuspend: '정지를 해제' }[kind];
    if (!label) return;
    if (!window.confirm((r.name || '이 회원') + ' 님의 ' + label + '할까요?')) return;
    api('POST', '/admin/users/' + encodeURIComponent(id) + '/' + kind)
      .then(function () { toast('처리되었습니다', 'success'); loadAll(); })
      .catch(handleErr);
  };

  ZG.preset = function (n) {
    if (!dlg) return;
    var base;
    if (dlg.kind === 'approve') {
      var s = (document.getElementById('zg-d-start') || {}).value;
      base = DATE_RE.test(s || '') ? s : todayKST();
    } else base = dlg.base;
    var end = document.getElementById('zg-d-end');
    if (end) end.value = addDays(base, n);
  };
  ZG.dlgClose = function () { closeDialog(); };
  ZG.dlgSubmit = function () {
    if (!dlg) return;
    var errEl = document.getElementById('zg-d-err');
    function fail(msg) { dlg.err = msg; if (errEl) errEl.textContent = msg; }
    var end = (document.getElementById('zg-d-end') || {}).value || '';
    var body, path;
    if (dlg.kind === 'approve') {
      var start = (document.getElementById('zg-d-start') || {}).value || '';
      if (!DATE_RE.test(start) || !DATE_RE.test(end)) return fail('날짜를 정확히 입력해 주세요.');
      if (end < start) return fail('종료일이 시작일보다 빠릅니다.');
      body = { startDate: start, endDate: end };
      path = '/admin/users/' + encodeURIComponent(dlg.id) + '/approve';
    } else {
      if (!DATE_RE.test(end)) return fail('날짜를 정확히 입력해 주세요.');
      if (end < todayKST()) return fail('새 만료일이 오늘보다 과거입니다.');
      body = { endDate: end };
      path = '/admin/users/' + encodeURIComponent(dlg.id) + '/extend';
    }
    var okBtn = document.getElementById('zg-d-ok');
    if (okBtn) okBtn.disabled = true;
    var kind = dlg.kind;
    api('POST', path, body)
      .then(function () {
        toast(kind === 'approve' ? '승인되었습니다' : '연장되었습니다', 'success');
        closeDialog();
        loadAll();
      })
      .catch(function (e) {
        if (e && e.status === 401) { handleErr(e); return; }
        if (okBtn) okBtn.disabled = false;
        fail((e && e.message) || '처리하지 못했습니다');
      });
  };

  // ----- 번호 편집 -----
  ZG.openEditor = function (id) {
    var r = byId(id);
    if (!r) return;
    api('GET', '/admin/users/' + encodeURIComponent(id) + '/phones')
      .then(function (d) {
        edit = {
          id: id,
          name: (d.main && d.main.name) || r.name || '',
          main: (d.main && d.main.phone) || r.phone,
          rows: (d.extras || []).map(function (x) {
            return { slot: x.slot, phone: fmtPhone(x.phone), label: x.label || '', isActive: x.isActive !== false };
          }),
          dirty: false, err: '', saving: false
        };
        drawModal();
      })
      .catch(handleErr);
  };

  ZG.closeEditor = function () {
    if (edit && edit.dirty && !window.confirm('저장하지 않은 변경사항이 있습니다. 닫을까요?')) return;
    closeModal();
  };

  ZG.addRow = function () {
    if (!edit || edit.rows.length >= MAX_EXTRA) return;
    var used = {};
    edit.rows.forEach(function (r) { used[r.slot] = true; });
    var slot = 0;
    for (var s = 2; s <= 5; s++) { if (!used[s]) { slot = s; break; } }
    if (!slot) return;
    edit.rows.push({ slot: slot, phone: '', label: '', isActive: true });
    edit.rows.sort(function (a, b) { return a.slot - b.slot; });
    edit.dirty = true;
    edit.err = '';
    drawModal();
  };

  ZG.delRow = function (i) {
    if (!edit || !edit.rows[i]) return;
    edit.rows.splice(i, 1);
    edit.dirty = true;
    edit.err = '';
    drawModal();
  };

  ZG.onField = function (el) {
    if (!edit) return;
    var i = parseInt(el.getAttribute('data-i'), 10);
    var f = el.getAttribute('data-f');
    var row = edit.rows[i];
    if (!row) return;
    if (f === 'isActive') {
      row.isActive = !!el.checked;
      if (el.parentNode && el.parentNode.parentNode) el.parentNode.parentNode.style.opacity = row.isActive ? 1 : 0.55;
    } else {
      row[f] = el.value;
      if (f === 'phone') {
        var d = digits(el.value);
        el.classList.toggle('bad', d.length > 0 && !PHONE_RE.test(d));
      }
    }
    edit.dirty = true;
    edit.err = '';
    var errEl = document.getElementById('zg-edit-err');
    if (errEl) errEl.textContent = '';
    refreshSaveState();
  };

  ZG.save = function () {
    if (!edit || edit.saving) return;
    var msg = validateEdit();
    if (msg) {
      edit.err = msg;
      var errEl = document.getElementById('zg-edit-err');
      if (errEl) errEl.textContent = msg;
      return;
    }
    edit.saving = true;
    refreshSaveState();
    var body = {
      extras: edit.rows.map(function (r) {
        return { slot: r.slot, phone: digits(r.phone), label: String(r.label || '').trim(), isActive: !!r.isActive };
      })
    };
    var id = edit.id;
    api('PUT', '/admin/users/' + encodeURIComponent(id) + '/phones', body)
      .then(function () {
        toast('저장되었습니다 (추가 번호 ' + body.extras.length + '개)', 'success');
        edit.dirty = false;
        closeModal();
      })
      .catch(function (e) {
        if (!edit) { handleErr(e); return; }
        edit.saving = false;
        if (e && e.status === 401) { handleErr(e); return; }
        edit.err = (e && e.message) || '저장에 실패했습니다';
        drawModal();
      });
  };

  // ---------- navigate() 가 호출하는 진입점 ----------
  window.renderZapgo = function () {
    injectStyle();
    setTimeout(function () {
      if (!root()) return;
      if (getToken()) { drawShell(); loadAll(); } else drawLogin();
    }, 0);
    return '<div id="zg-root"></div>';
  };
})();
