/* =====================================================================
 * zapgo-admin.js — QUICK ADMIN 부가 모듈: "잡고 멀티 번호" 관리
 *
 *  - 토스/그랩 화면·DB(Supabase)와 완전히 분리. 잡고 서버(zapgo-api)와만 통신한다.
 *  - 자체 로그인: zapgo-api 관리자 계정(서버에서 비밀번호 검증) → 토큰은 탭을
 *    닫으면 사라지는 sessionStorage 에만 보관.
 *  - 기사 1명 = 메인 번호 1개(변경 불가) + 추가 번호 최대 4개(관리자만 설정).
 *  - 추가/삭제는 화면에만 반영했다가 "저장"을 눌러야 서버에 반영된다.
 *
 *  index.html 연결(3곳): 메뉴 항목 / navigate 표(zapgo) / 이 스크립트 태그
 * ===================================================================== */
(function () {
  'use strict';

  var API = 'https://64-176-231-115.sslip.io/api';
  var TOKEN_KEY = 'zapgo_admin_token';
  var MAX_EXTRA = 4;
  var PHONE_RE = /^01[016789]\d{7,8}$/;
  var STATUS = {
    approved: ['승인', 'ok'],
    pending: ['대기', 'wait'],
    suspended: ['정지', 'stop'],
    rejected: ['거절', 'stop']
  };

  var state = { riders: [], q: '', status: '' };
  var edit = null; // { id, name, main, rows:[{slot,phone,label,isActive}], dirty, err, saving }

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
    try { return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); } catch (e) { return iso.slice(0, 10); }
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else window.alert(msg);
  }
  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) {
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* 무시 */ }
  }
  function root() { return document.getElementById('zg-root'); }

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
      '.zg-wrap{max-width:980px}' +
      '.zg-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}' +
      '.zg-title{font-size:18px;font-weight:700}' +
      '.zg-sub{font-size:12px;color:var(--text3);margin-bottom:14px;line-height:1.6}' +
      '.zg-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}' +
      '.zg-bar input,.zg-bar select{background:var(--bg3);border:1px solid var(--border);border-radius:7px;padding:8px 10px;color:var(--text);font-size:12px;outline:none}' +
      '.zg-bar input{flex:1;min-width:160px}' +
      '.zg-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;background:var(--bg3);border:1px solid var(--border);border-radius:9px;margin-bottom:7px}' +
      '.zg-main{min-width:0;flex:1}' +
      '.zg-name{font-size:13px;font-weight:600}' +
      '.zg-meta{font-size:11px;color:var(--text3);margin-top:3px;font-family:monospace}' +
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
      '.zg-note{font-size:11px;color:var(--text3);line-height:1.6;margin:8px 0}';
    document.head.appendChild(st);
  }

  // ---------- 화면: 로그인 ----------
  function drawLogin(msg) {
    var el = root();
    if (!el) return;
    el.innerHTML =
      '<div class="zg-wrap">' +
      '<div class="zg-title" style="margin-bottom:6px">🛵 잡고 · 멀티 번호 관리</div>' +
      '<div class="zg-sub">잡고 서버 관리자 계정으로 로그인해 주세요. (토스/그랩 어드민 로그인과 별개입니다)</div>' +
      '<div class="zg-card">' +
      '<div class="fg"><label class="fl">아이디</label><input class="fi2" id="zg-id" autocomplete="username" onkeydown="if(event.key===\'Enter\')document.getElementById(\'zg-pw\').focus()"></div>' +
      '<div class="fg"><label class="fl">비밀번호</label><input class="fi2" id="zg-pw" type="password" autocomplete="current-password" onkeydown="if(event.key===\'Enter\')ZG.login()"></div>' +
      '<div class="zg-err" id="zg-login-err">' + esc(msg || '') + '</div>' +
      '<button class="btn btn-p" id="zg-login-btn" style="width:100%;margin-top:6px" onclick="ZG.login()">로그인</button>' +
      '</div></div>';
  }

  // ---------- 화면: 기사 목록 ----------
  function drawShell() {
    var el = root();
    if (!el) return;
    el.innerHTML =
      '<div class="zg-wrap">' +
      '<div class="zg-head"><div class="zg-title">🛵 잡고 · 멀티 번호 관리</div>' +
      '<div style="display:flex;gap:6px">' +
      '<button class="btn btn-g btn-sm" onclick="ZG.refresh()">↻ 새로고침</button>' +
      '<button class="btn btn-g btn-sm" onclick="ZG.logout()">잡고 로그아웃</button></div></div>' +
      '<div class="zg-sub">기사 1명당 <b>메인 번호 1개 + 추가 번호 최대 ' + MAX_EXTRA + '개</b>(총 5개). ' +
      '추가 번호는 관리자만 설정할 수 있고, 기사는 앱에서 등록된 번호끼리 전환만 합니다. ' +
      '반드시 <b>기사 본인이 사용하는 번호</b>만 등록하세요.</div>' +
      '<div class="zg-bar">' +
      '<input id="zg-q" placeholder="이름 / 아이디 / 번호 검색" oninput="ZG.setQ(this.value)">' +
      '<select id="zg-status" onchange="ZG.setStatus(this.value)">' +
      '<option value="">전체 상태</option><option value="approved">승인</option>' +
      '<option value="pending">대기</option><option value="suspended">정지</option>' +
      '<option value="rejected">거절</option></select></div>' +
      '<div id="zg-rows"><div class="zg-empty">불러오는 중…</div></div></div>';
    var q = document.getElementById('zg-q');
    var s = document.getElementById('zg-status');
    if (q) q.value = state.q;
    if (s) s.value = state.status;
  }

  function drawRows() {
    var box = document.getElementById('zg-rows');
    if (!box) return;
    var q = state.q.trim().toLowerCase();
    var qd = digits(state.q);
    var list = state.riders.filter(function (r) {
      if (!q) return true;
      return String(r.name || '').toLowerCase().indexOf(q) >= 0 ||
        String(r.username || '').toLowerCase().indexOf(q) >= 0 ||
        (qd && digits(r.phone).indexOf(qd) >= 0);
    });
    if (!list.length) {
      box.innerHTML = '<div class="zg-empty">표시할 기사가 없습니다</div>';
      return;
    }
    box.innerHTML = list.map(function (r) {
      var st = STATUS[r.status] || [r.status || '—', 'wait'];
      return '<div class="zg-row"><div class="zg-main">' +
        '<div class="zg-name">' + esc(r.name || '(이름 없음)') +
        (r.username ? ' <span style="font-weight:400;color:var(--text3)">@' + esc(r.username) + '</span>' : '') +
        '<span class="zg-pill ' + st[1] + '">' + esc(st[0]) + '</span></div>' +
        '<div class="zg-meta">📞 ' + esc(fmtPhone(r.phone)) + ' · 만료 ' + esc(fmtDate(r.membershipExpiresAt)) + '</div>' +
        '</div><button class="btn btn-p btn-sm" data-id="' + esc(r.id) + '" onclick="ZG.openEditor(this.dataset.id)">📱 번호 관리</button></div>';
    }).join('');
  }

  function loadRiders() {
    if (!getToken()) { drawLogin(); return; }
    drawShell();
    api('GET', '/admin/users' + (state.status ? '?status=' + encodeURIComponent(state.status) : ''))
      .then(function (list) {
        state.riders = Array.isArray(list) ? list : [];
        drawRows();
      })
      .catch(function (e) {
        var box = document.getElementById('zg-rows');
        if (box) box.innerHTML = '<div class="zg-empty">불러오지 못했습니다: ' + esc(e.message) + '</div>';
        handleErr(e);
      });
  }

  // ---------- 화면: 번호 편집 모달 ----------
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
    var btn = document.getElementById('zg-login-btn');
    if (!id.trim() || !pw) { if (err) err.textContent = '아이디와 비밀번호를 입력하세요'; return; }
    if (btn) btn.disabled = true;
    api('POST', '/admin/login', { username: id.trim(), password: pw })
      .then(function (res) {
        if (!res || !res.token) throw new Error('로그인 응답이 올바르지 않습니다');
        setToken(res.token);
        loadRiders();
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        var pwEl = document.getElementById('zg-pw');
        if (pwEl) pwEl.value = '';
        if (err) err.textContent = e.status === 401 ? '아이디 또는 비밀번호가 올바르지 않습니다' : (e.message || '로그인에 실패했습니다');
      });
  };
  ZG.logout = function () { setToken(null); state.riders = []; closeModal(); drawLogin(); };
  ZG.refresh = function () { loadRiders(); };
  ZG.setQ = function (v) { state.q = v || ''; drawRows(); };
  ZG.setStatus = function (v) { state.status = v || ''; loadRiders(); };

  ZG.openEditor = function (id) {
    var r = state.riders.filter(function (x) { return x.id === id; })[0];
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
    setTimeout(function () { if (root()) { if (getToken()) loadRiders(); else drawLogin(); } }, 0);
    return '<div id="zg-root"></div>';
  };
})();
