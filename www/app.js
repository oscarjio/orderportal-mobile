/* OrderPortal Mobile — huvud-app */
(async function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const STORE_KEY = 'orderportal_auth_v1';

  // --- Toast ---
  function toast(msg, type = 'success', ms = 2500) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
    el.textContent = msg;
    $('#toast').appendChild(el);
    requestAnimationFrame(() => el.style.opacity = '1');
    setTimeout(() => {
      el.style.opacity = '0'; el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  // --- State ---
  const digest = new DigestAuth();
  const client = new PPClient(digest);
  let currentTab = 'time';
  let orders = [];
  let timeEntries = [];
  let dayStats = { work: {}, addons: {} };
  let selectedDay = null;
  let calViewDate = new Date();
  let timeTypes = [];
  let snabbvalArts = [];
  let currentDetailOrder = null;
  let currentDetailTab = 'time';

  // --- Storage via Capacitor Preferences om finns, annars localStorage ---
  const Storage = {
    async get(k) {
      try {
        if (window.Capacitor?.Plugins?.Preferences) {
          const r = await Capacitor.Plugins.Preferences.get({ key: k });
          return r?.value;
        }
      } catch {}
      return localStorage.getItem(k);
    },
    async set(k, v) {
      try {
        if (window.Capacitor?.Plugins?.Preferences) {
          await Capacitor.Plugins.Preferences.set({ key: k, value: v });
          return;
        }
      } catch {}
      localStorage.setItem(k, v);
    },
    async remove(k) {
      try {
        if (window.Capacitor?.Plugins?.Preferences) {
          await Capacitor.Plugins.Preferences.remove({ key: k });
          return;
        }
      } catch {}
      localStorage.removeItem(k);
    },
  };

  // --- ISO week helpers ---
  const isoDate = (d) => d.toISOString().slice(0, 10);
  function addDays(iso, n) { const d = new Date(iso); d.setDate(d.getDate() + n); return isoDate(d); }
  function isoWeek(d) {
    const date = new Date(d); date.setHours(0,0,0,0);
    date.setDate(date.getDate() + 4 - (date.getDay() || 7));
    const ys = new Date(date.getFullYear(), 0, 1);
    return Math.ceil((((date - ys) / 86400000) + 1) / 7);
  }
  function weekMonday(d) {
    const date = new Date(d);
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - (day - 1));
    return date;
  }

  // --- Login ---
  async function tryRestoreSession() {
    const saved = await Storage.get(STORE_KEY);
    if (!saved) return false;
    try {
      digest.fromJSON(JSON.parse(saved));
      if (!digest.ha1 || !digest.clientId) return false;
      // Validera genom ett enkelt anrop
      try {
        await client._request('GET', '/authenticate');
        return true;
      } catch (e) {
        console.warn('Sparad session ogiltig:', e.message);
        return false;
      }
    } catch { return false; }
  }

  $('#btnLogin').addEventListener('click', async () => {
    const u = $('#loginUser').value.trim();
    const p = $('#loginPass').value;
    if (!u || !p) { $('#loginErr').hidden = false; $('#loginErr').textContent = 'Fyll i både användarnamn och lösenord'; return; }
    const btn = $('#btnLogin'); btn.disabled = true; btn.textContent = 'Loggar in...';
    $('#loginErr').hidden = true;
    try {
      await client.login(u, p);
      await Storage.set(STORE_KEY, JSON.stringify(digest.toJSON()));
      showApp();
    } catch (e) {
      $('#loginErr').hidden = false; $('#loginErr').textContent = e.message || 'Inloggning misslyckades';
    } finally {
      btn.disabled = false; btn.textContent = 'Logga in';
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    if (!confirm('Logga ut?')) return;
    await Storage.remove(STORE_KEY);
    digest.clear();
    $('#viewApp').hidden = true;
    $('#viewLogin').hidden = false;
    $('#loginPass').value = '';
  });

  $('#btnRefresh').addEventListener('click', () => refreshCurrentTab());

  function showApp() {
    $('#viewLogin').hidden = true;
    $('#viewApp').hidden = false;
    // Persist-session varje gång nc räknas upp
    setInterval(async () => {
      await Storage.set(STORE_KEY, JSON.stringify(digest.toJSON()));
    }, 30000);
    // Start: ladda tid
    loadTime();
    loadOrders().catch(e => console.warn('orders fail', e));
    loadTimeTypes().catch(() => {});
  }

  // --- Tab-byte ---
  $$('.nav-btn').forEach(b => b.addEventListener('click', () => {
    const tab = b.dataset.tab;
    $$('.nav-btn').forEach(x => x.classList.toggle('active', x === b));
    $$('.tab-view').forEach(v => v.hidden = v.dataset.tab !== tab);
    currentTab = tab;
    $('#pageTitle').textContent = { time: 'Tid', orders: 'Ordrar', detail: 'Order' }[tab] || tab;
  }));

  function refreshCurrentTab() {
    if (currentTab === 'time') loadTime();
    else if (currentTab === 'orders') loadOrders();
    else if (currentTab === 'detail' && currentDetailOrder) loadDetail(currentDetailOrder);
  }

  // --- TID ---
  async function loadTime() {
    toast('Laddar tid...', 'info', 1200);
    try {
      // 5 veckor centrerade runt calViewDate
      const center = weekMonday(calViewDate);
      const firstMon = new Date(center); firstMon.setDate(center.getDate() - 14);
      const spans = [];
      for (let w = 0; w < 5; w++) {
        const mon = new Date(firstMon); mon.setDate(firstMon.getDate() + w * 7);
        const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
        spans.push({ monday: isoDate(mon), sunday: isoDate(sun) });
      }
      const responses = await Promise.all(spans.map(s =>
        client.getTimeWeek(s.monday, s.sunday).catch(() => null)
      ));
      const entries = [];
      const work = {}, addons = {};
      let meId = null, meName = '';
      for (let i = 0; i < responses.length; i++) {
        const d = responses[i];
        if (!d) continue;
        const users = d.AllUsersReportTime || [];
        const me = users[0];
        if (!me) continue;
        if (me.UserId) meId = me.UserId;
        meName = me.UserName || meName;
        const list = me.UserActualTimeList || [];
        for (const t of list) {
          const datum = String(t.Timestamp || t.Date || '').substring(0, 10);
          const qty = Number(t.Quantity || 0);
          const name = String(t.TimeTypeName || '').trim();
          const isWork = (Number(t.TimeTypeId || 0) === 0 && !name)
                     || /^arbetstid/i.test(name)
                     || /^övertid/i.test(name)
                     || /ötid/i.test(name);
          if (datum) {
            if (isWork) work[datum] = (work[datum] || 0) + qty;
            else addons[datum] = (addons[datum] || 0) + 1;
          }
          entries.push({
            id: 'a_' + (t.ActualTimeId || Math.random()),
            datum, antal: qty,
            tidkod: t.TimeTypeName || (isWork ? 'Arbetstid' : ''),
            order: String(t.ProjectNumber || t.ProjectId || ''),
            projectId: t.ProjectId,
            projekt: t.ProjectName || '',
            text: t.Comment || '',
            kind: isWork ? 'arbete' : 'tillägg',
          });
        }
      }
      if (meId) digest.cachedUserId = meId;
      timeEntries = entries;
      dayStats = { work, addons };

      // Bilzoner
      const pids = new Set();
      for (const e of entries) { if (e.projectId) pids.add(Number(e.projectId)); }
      if (pids.size) {
        const mats = await Promise.all([...pids].map(pid =>
          client.getOrderMaterials(pid).then(r => ({ pid, rows: r.rows })).catch(() => ({ pid, rows: [] }))
        ));
        const dateSet = new Set();
        spans.forEach(s => { for (let d = 0; d < 7; d++) dateSet.add(addDays(s.monday, d)); });
        for (const mr of mats) {
          for (const m of mr.rows) {
            const uId = m.UserId;
            if (meId && uId && uId !== meId) continue;
            const name = (m.Name || '').toLowerCase();
            if (!name.includes('bil') && !/^9999(0[1-8])$/.test(String(m.ArticleNumber || ''))) continue;
            const datum = String(m.ReportDate || m.Timestamp || '').substring(0, 10);
            if (!datum || !dateSet.has(datum)) continue;
            addons[datum] = (addons[datum] || 0) + 1;
            timeEntries.push({
              id: 'bil_' + (m.ActualMaterialId || Math.random()),
              datum, antal: Number(m.ReportedQty || 0),
              tidkod: m.Name || 'Bilzon',
              order: String(m.ProjectNumber || m.ProjectId || mr.pid),
              projectId: Number(m.ProjectId || mr.pid),
              projekt: m.ProjectName || '',
              text: m.ArticleNumber || '',
              kind: 'bilzon',
            });
          }
        }
      }
      dayStats = { work, addons };
      renderMiniCal();
      renderDayList();
    } catch (e) {
      console.error(e);
      toast('Kunde inte ladda tid: ' + e.message, 'error', 3500);
    }
  }

  function renderMiniCal() {
    const cal = $('#miniCal');
    const todayIso = isoDate(new Date());
    const center = weekMonday(calViewDate);
    const firstMon = new Date(center); firstMon.setDate(center.getDate() - 14);
    const weeks = [];
    for (let w = 0; w < 5; w++) {
      const start = new Date(firstMon); start.setDate(firstMon.getDate() + w * 7);
      weeks.push({ iso: isoDate(start), w: isoWeek(start) });
    }
    const monthLbl = calViewDate.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
    let html = `<div class="mini-cal-nav">
      <button id="calPrev">‹</button>
      <div class="mini-cal-month">${monthLbl}</div>
      <button id="calToday">Idag</button>
      <button id="calNext">›</button>
    </div><div class="cal-grid">
      <div></div>${['M','T','O','T','F','L','S'].map(d => `<div class="cal-head">${d}</div>`).join('')}
    `;
    for (const wk of weeks) {
      html += `<div class="cal-week-num">${wk.w}</div>`;
      for (let i = 0; i < 7; i++) {
        const d = addDays(wk.iso, i);
        const isWeekend = i >= 5;
        const hrs = dayStats.work[d] || 0;
        const adds = dayStats.addons[d] || 0;
        const target = isWeekend ? 0 : 8;
        const ok = !isWeekend && hrs >= target;
        const cls = ['cal-cell'];
        if (isWeekend) cls.push('weekend');
        if (d === todayIso) cls.push('today');
        if (d === selectedDay) cls.push('selected');
        html += `<div class="${cls.join(' ')}" data-date="${d}">
          <div class="cal-num">${new Date(d).getDate()}</div>
          <div class="cal-chips">
            <span class="cal-chip ${ok ? 'ok' : ''}">${hrs || ''}</span>
            ${adds > 0 ? `<span class="cal-chip addon">${adds}</span>` : ''}
          </div>
        </div>`;
      }
    }
    html += '</div>';
    cal.innerHTML = html;

    $('#calPrev').onclick = () => { calViewDate.setMonth(calViewDate.getMonth()-1); loadTime(); };
    $('#calNext').onclick = () => { calViewDate.setMonth(calViewDate.getMonth()+1); loadTime(); };
    $('#calToday').onclick = () => { calViewDate = new Date(); selectedDay = null; loadTime(); };
    cal.querySelectorAll('[data-date]').forEach(el => {
      el.addEventListener('click', () => {
        const d = el.dataset.date;
        selectedDay = (selectedDay === d) ? null : d;
        renderMiniCal();
        renderDayList();
      });
    });
  }

  function renderDayList() {
    const list = $('#dayList');
    const rows = selectedDay
      ? timeEntries.filter(e => e.datum === selectedDay)
      : timeEntries;
    if (!rows.length) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:40px 20px;">
        ${selectedDay ? 'Inga tidrader på ' + selectedDay : 'Inga tidrader i vyn'}
      </div>`;
      return;
    }
    // Gruppera per datum
    const byDate = {};
    for (const e of rows) { (byDate[e.datum] = byDate[e.datum] || []).push(e); }
    const dates = Object.keys(byDate).sort().reverse();
    list.innerHTML = dates.map(d => {
      const entries = byDate[d];
      const hrs = entries.filter(e => e.kind !== 'bilzon').reduce((s, e) => s + e.antal, 0);
      const lbl = new Date(d).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
      return `<div class="day-group">
        <div class="day-header"><span>${lbl}</span><span class="sum">${hrs}h</span></div>
        ${entries.map(e => `
          <div class="entry-row" data-entry-id="${e.id}">
            <div class="entry-main">
              <div class="entry-title">${e.tidkod || '(okänt)'}${e.kind === 'bilzon' ? '<span class="entry-badge">BILZON</span>' : ''}</div>
              <div class="entry-meta">${e.order}${e.projekt ? ' · ' + e.projekt : ''}${e.text ? ' · ' + e.text : ''}</div>
            </div>
            <div class="entry-qty ${e.kind === 'bilzon' ? 'bilzon' : ''}">${e.antal}${e.kind !== 'bilzon' ? 'h' : ''}</div>
          </div>`).join('')}
      </div>`;
    }).join('');

    // Klick → öppna order
    list.querySelectorAll('.entry-row').forEach(r => {
      r.addEventListener('click', () => {
        const id = r.dataset.entryId;
        const e = rows.find(x => x.id === id);
        if (!e || !e.order) return;
        const ord = orders.find(o => String(o.ProjectNumber) === String(e.order))
                 || orders.find(o => Number(o.ProjectId) === Number(e.projectId));
        if (ord) openDetail(ord);
      });
    });
  }

  // --- ORDRAR ---
  async function loadOrders() {
    try {
      const r = await client.listServiceOrders({ tabIndex: 8, endRow: 100 });
      orders = Array.isArray(r) ? r : (r?.Rows || r?.rows || r?.Data || []);
      renderOrders();
    } catch (e) { console.warn(e); toast('Kunde inte ladda ordrar', 'error'); }
  }

  $('#orderSearch').addEventListener('input', () => renderOrders());

  function renderOrders() {
    const list = $('#orderList');
    const q = $('#orderSearch').value.toLowerCase().trim();
    const filtered = orders.filter(o => {
      if (!q) return true;
      return (String(o.ProjectNumber || '').includes(q))
          || (String(o.ProjectName || '').toLowerCase().includes(q))
          || (String(o.CustomerName || '').toLowerCase().includes(q));
    });
    list.innerHTML = filtered.map(o => `
      <div class="order-card" data-pid="${o.ProjectId}">
        <div class="order-nr">${o.ProjectNumber || o.ProjectId}</div>
        <div class="order-title">${o.ProjectName || '(utan beskrivning)'}</div>
        <div class="order-meta">
          <span>${o.CustomerName || ''}</span>
          ${o.StatusName ? `<span>· ${o.StatusName}</span>` : ''}
        </div>
      </div>`).join('') || '<div style="text-align:center;color:var(--text-dim);padding:40px 20px;">Inga ordrar</div>';
    list.querySelectorAll('.order-card').forEach(c => {
      c.addEventListener('click', () => {
        const pid = Number(c.dataset.pid);
        const o = orders.find(x => x.ProjectId === pid);
        if (o) openDetail(o);
      });
    });
  }

  // --- DETALJ ---
  async function openDetail(order) {
    currentDetailOrder = order;
    currentDetailTab = 'time';
    $('#pageTitle').textContent = 'Order';
    $$('.tab-view').forEach(v => v.hidden = v.dataset.tab !== 'detail');
    currentTab = 'detail';
    $('#detailTitle').textContent = `${order.ProjectNumber || order.ProjectId} — ${order.ProjectName || ''}`;
    $('#detailSubtitle').textContent = `${order.CustomerName || ''}${order.StatusName ? ' · ' + order.StatusName : ''}`;
    loadDetail(order);
  }

  $('#btnBackDetail').addEventListener('click', () => {
    currentDetailOrder = null;
    // Gå tillbaka till ordrar-tab
    $$('.nav-btn').forEach(x => x.classList.toggle('active', x.dataset.tab === 'orders'));
    $$('.tab-view').forEach(v => v.hidden = v.dataset.tab !== 'orders');
    currentTab = 'orders';
    $('#pageTitle').textContent = 'Ordrar';
  });

  $$('#detailTabs .tab').forEach(t => t.addEventListener('click', () => {
    currentDetailTab = t.dataset.dtab;
    $$('#detailTabs .tab').forEach(x => x.classList.toggle('active', x === t));
    $$('.detail-panel').forEach(p => p.hidden = p.dataset.dpanel !== currentDetailTab);
  }));

  async function loadDetail(order) {
    $('#detailTimePanel').innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-dim);">Laddar...</div>';
    $('#detailMaterialPanel').innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--text-dim);">Laddar...</div>';
    try {
      // Material
      const mat = await client.getOrderMaterials(order.ProjectId);
      const matRows = mat.rows || [];
      $('#detailMaterialPanel').innerHTML = matRows.length ? matRows.map(m => `
        <div class="day-group">
          <div class="day-header" style="background:#fff;">
            <span>${m.Name || m.ArticleName || '(material)'}</span>
            <span class="sum">${m.ReportedQty || 0} ${m.MaterialUnitCode || m.UnitCode || 'st'}</span>
          </div>
          <div class="entry-row" style="border-bottom:none;">
            <div class="entry-main">
              <div class="entry-meta">${m.ArticleNumber || ''} · ${String(m.ReportDate || '').substring(0,10)}</div>
            </div>
          </div>
        </div>`).join('') : '<div style="padding:40px 20px;text-align:center;color:var(--text-dim);">Inget material på ordern</div>';

      // Tidrader för order (filtrera globala timeEntries)
      const timeRows = timeEntries.filter(e => Number(e.projectId) === Number(order.ProjectId));
      $('#detailTimePanel').innerHTML = timeRows.length ? timeRows.map(e => `
        <div class="day-group">
          <div class="day-header" style="background:#fff;">
            <span>${new Date(e.datum).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })}</span>
            <span class="sum">${e.antal}h</span>
          </div>
          <div class="entry-row" style="border-bottom:none;">
            <div class="entry-main">
              <div class="entry-title">${e.tidkod}</div>
              <div class="entry-meta">${e.text || ''}</div>
            </div>
          </div>
        </div>`).join('') : '<div style="padding:40px 20px;text-align:center;color:var(--text-dim);">Inga tidrader i nuvarande vy</div>';
    } catch (e) {
      toast('Fel vid laddning: ' + e.message, 'error');
    }
  }

  $('#btnDetailAction').addEventListener('click', () => {
    // Öppna tidskrivning med förifyllt projekt
    if (!currentDetailOrder) return;
    openTimeModal({
      kundorder: currentDetailOrder.ProjectNumber || currentDetailOrder.ProjectId,
      projectId: currentDetailOrder.ProjectId,
      projekt: currentDetailOrder.ProjectName,
    });
  });

  // --- TIDKODER ---
  async function loadTimeTypes() {
    try {
      timeTypes = await client.getTimeTypes();
      const visible = timeTypes.filter(t => t.IsShowInMobileApp);
      const sel = $('#inpTidkod');
      sel.innerHTML = `<option value="010" data-time-type-id="0">Arbetstid</option>` +
        visible.map(t => `<option value="__TT_${t.TimeTypeId}" data-time-type-id="${t.TimeTypeId}">${t.Name}${t.Percentage ? ` (${t.Percentage}%)` : ''}</option>`).join('');
    } catch (e) { console.warn('timeTypes', e); }
  }

  // --- MODAL: Tidskrivning ---
  function openTimeModal(prefill = {}) {
    const m = $('#modalTime');
    m.hidden = false;
    $('#inpDatum').value = isoDate(new Date());
    $('#inpKundorder').value = prefill.kundorder || '';
    $('#hintKundorder').textContent = prefill.projekt || '';
    $('#inpKundorder').dataset.projectId = prefill.projectId || '';
    $('#inpAntal').value = '';
    $('#inpText').value = '';
    $('#inpTidkod').value = '010';
    // Reset material panel
    $('#inpArticle').value = '';
    $('#inpMatAntal').value = '1';
    $('#inpMatPris').value = '';
    $('#inpMatText').value = '';
    $('#mvKundorder').textContent = prefill.kundorder || '(välj på Tidkod-fliken först)';
    switchMTab('form');
    setTimeout(() => $('#inpAntal').focus(), 150);
  }
  function closeTimeModal() { $('#modalTime').hidden = true; }

  $('#btnAddTime').addEventListener('click', () => openTimeModal());
  $$('[data-close]').forEach(b => b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true; }));

  function switchMTab(tab) {
    $$('.mtab').forEach(x => x.classList.toggle('active', x.dataset.mtab === tab));
    $$('.mpanel').forEach(p => p.hidden = p.dataset.mpanel !== tab);
    if (tab === 'material') {
      $('#mvKundorder').textContent = $('#inpKundorder').value || '(välj på Tidkod-fliken först)';
      if (!snabbvalArts.length) loadSnabbval();
    }
  }
  $$('.mtab').forEach(b => b.addEventListener('click', () => switchMTab(b.dataset.mtab)));

  // Kundorder-autocomplete
  function setupKundorderAC() {
    const inp = $('#inpKundorder');
    const dd = $('#ddKundorder');
    const hint = $('#hintKundorder');
    const render = () => {
      const q = inp.value.toLowerCase().trim();
      const matches = orders.filter(o =>
        !q || String(o.ProjectNumber || '').includes(q)
           || (o.ProjectName || '').toLowerCase().includes(q)
           || (o.CustomerName || '').toLowerCase().includes(q)
      ).slice(0, 30);
      if (!matches.length) { dd.hidden = true; return; }
      dd.innerHTML = matches.map(o => `
        <div class="ac-item" data-pid="${o.ProjectId}" data-nr="${o.ProjectNumber}" data-name="${(o.ProjectName||'').replace(/"/g,'&quot;')}">
          <div><span class="ac-nr">${o.ProjectNumber || o.ProjectId}</span> ${o.ProjectName || ''}</div>
          <div class="ac-sub">${o.CustomerName || ''}</div>
        </div>`).join('');
      dd.hidden = false;
    };
    inp.addEventListener('focus', render);
    inp.addEventListener('input', () => { inp.dataset.projectId = ''; hint.textContent = ''; render(); });
    inp.addEventListener('blur', () => setTimeout(() => { dd.hidden = true; }, 180));
    dd.addEventListener('mousedown', (e) => {
      const it = e.target.closest('.ac-item');
      if (!it) return;
      e.preventDefault();
      inp.value = it.dataset.nr;
      inp.dataset.projectId = it.dataset.pid;
      hint.textContent = it.dataset.name;
      dd.hidden = true;
    });
  }

  // Artikel-autocomplete
  async function loadSnabbval() {
    try {
      const r = await client.searchSnabbvalArticles({ articleGroupId: 7122, top: 50 });
      snabbvalArts = Array.isArray(r?.Articles) ? r.Articles : [];
    } catch (e) { console.warn('snabbval', e); }
  }
  function setupArticleAC() {
    const inp = $('#inpArticle');
    const dd = $('#ddArticle');
    const hint = $('#hintArticle');
    const render = () => {
      const q = inp.value.toLowerCase().trim();
      const matches = (q ? snabbvalArts.filter(a => (a.Name||'').toLowerCase().includes(q) || (a.ArticleNumber||'').includes(q)) : snabbvalArts).slice(0, 40);
      if (!matches.length) { dd.innerHTML = '<div class="ac-item muted">Inga träffar</div>'; dd.hidden = false; return; }
      dd.innerHTML = matches.map(a => `
        <div class="ac-item" data-id="${a.ArticleId}" data-nr="${a.ArticleNumber}" data-name="${(a.Name||'').replace(/"/g,'&quot;')}">
          <div><span class="ac-nr">${a.ArticleNumber}</span> ${a.Name}</div>
          <div class="ac-sub">${a.UnitCode || 'st'}${a.SalesPrice ? ' · ' + a.SalesPrice + ' kr' : ''}</div>
        </div>`).join('');
      dd.hidden = false;
    };
    inp.addEventListener('focus', () => { loadSnabbval().then(render); });
    inp.addEventListener('input', render);
    inp.addEventListener('blur', () => setTimeout(() => { dd.hidden = true; }, 180));
    dd.addEventListener('mousedown', async (e) => {
      const it = e.target.closest('.ac-item');
      if (!it) return;
      e.preventDefault();
      const id = Number(it.dataset.id);
      const art = snabbvalArts.find(a => a.ArticleId === id);
      if (!art) return;
      inp.value = art.Name;
      inp.dataset.articleId = id;
      inp.dataset.articleNumber = art.ArticleNumber;
      hint.textContent = `${art.ArticleNumber} · ${art.UnitCode || 'st'}`;
      dd.hidden = true;
      // Slå upp pris
      const pid = $('#inpKundorder').dataset.projectId;
      if (pid && id) {
        try {
          const det = await client.getArticleSalesPrice(id, Number(pid));
          if (det?.Price) $('#inpMatPris').value = Number(det.Price);
          if (det?.UnitId) inp.dataset.materialUnitId = det.UnitId;
          if (det?.PurchasePrice) inp.dataset.purchasePrice = det.PurchasePrice;
        } catch {}
      }
    });
  }

  setupKundorderAC();
  setupArticleAC();

  // Spara tid eller material beroende på aktiv flik
  $('#btnSaveTime').addEventListener('click', async () => {
    const activeTab = $('.mtab.active')?.dataset.mtab || 'form';
    const pid = $('#inpKundorder').dataset.projectId;
    if (!pid) { toast('Välj kundorder först', 'error'); return; }

    try {
      if (activeTab === 'material') {
        const artId = $('#inpArticle').dataset.articleId;
        const artNr = $('#inpArticle').dataset.articleNumber;
        if (!artId) { toast('Välj en artikel först', 'error'); return; }
        const antal = Number($('#inpMatAntal').value || 0);
        if (!antal) { toast('Ange antal', 'error'); return; }
        await client.addMaterial({
          projectId: Number(pid),
          articleId: Number(artId),
          articleNumber: artNr,
          benamning: $('#inpArticle').value,
          antal,
          enhet: 'st',
          prisPerEnhet: Number($('#inpMatPris').value || 0),
          materialUnitId: Number($('#inpArticle').dataset.materialUnitId || 0),
          purchasePrice: Number($('#inpArticle').dataset.purchasePrice || 0),
          discount: 0,
        });
        toast('Material tillagt', 'success');
      } else {
        const antal = Number($('#inpAntal').value || 0);
        if (!antal) { toast('Ange antal timmar', 'error'); return; }
        const sel = $('#inpTidkod');
        const opt = sel.selectedOptions[0];
        const ttId = opt?.dataset.timeTypeId != null ? Number(opt.dataset.timeTypeId) : 0;
        const tt = timeTypes.find(t => t.TimeTypeId === ttId);
        let cat = 'actual';
        if (tt?.AbsenceTypeId > 0) cat = 'absence';
        else if (tt?.IsClaimsType) cat = 'claims';
        await client.createTime({
          datum: $('#inpDatum').value,
          tidkod: sel.value,
          timeTypeId: ttId,
          category: cat,
          projectId: Number(pid),
          antal,
          text: $('#inpText').value,
        });
        toast(`${antal}h sparad på ${$('#inpKundorder').value}`, 'success');
      }
      closeTimeModal();
      loadTime();
    } catch (e) {
      toast('Kunde inte spara: ' + e.message, 'error', 4000);
    }
  });

  // --- START ---
  if (await tryRestoreSession()) {
    showApp();
  } else {
    $('#viewLogin').hidden = false;
  }

  // Initial bottom-nav active
  $$('.nav-btn')[0].classList.add('active');
})();
