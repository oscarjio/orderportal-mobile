/**
 * Browser-port av Projektportalen-klienten.
 * Använder direkt fetch() som på Android automatiskt routas genom
 * CapacitorHttp (bypass:ar CORS för native webview).
 */
(function (global) {
  'use strict';

  const BASE = 'https://api-app3.projektportalen.se/api';

  function qs(obj) {
    if (!obj) return '';
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.join('&');
  }

  class PPClient {
    constructor(digestAuth) {
      this.digestAuth = digestAuth || new DigestAuth();
      this._nonceRefreshPromise = null;
    }

    async _request(method, path, { body, query, skipAuth = false } = {}) {
      const q = qs(query);
      const pathWithQuery = q ? `${path}?${q}` : path;
      const url = `${BASE}${pathWithQuery}`;
      const authUri = '/api' + path; // utan query enligt verifierat format

      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8',
        'lang': 'sv',
        'languageId': '1',
        'client-timezone-offset': String(-new Date().getTimezoneOffset()),
      };
      let payload;
      if (body !== undefined && body !== null) {
        if (typeof body === 'object') {
          headers['Content-Type'] = 'application/json';
          payload = JSON.stringify(body);
        } else {
          payload = body;
        }
      }
      if (method === 'POST' && payload === undefined) {
        headers['Content-Length'] = '0';
      }

      if (!skipAuth && this.digestAuth.ha1) {
        try {
          headers['Authorization'] = await this.digestAuth.buildAuthorizationHeader(method, authUri);
        } catch {}
      }

      let resp = await fetch(url, { method, headers, body: payload });

      if (!skipAuth && resp.status === 401) {
        const chal = resp.headers.get('www-authenticate');
        if (chal) {
          this.digestAuth.setChallenge(chal);
          headers['Authorization'] = await this.digestAuth.buildAuthorizationHeader(method, authUri);
          resp = await fetch(url, { method, headers, body: payload });
        } else {
          // Försök nonce-refresh via /authenticate
          const txt = await resp.text().catch(() => '');
          if (/nonce.*(validate|fail|expire|invalid)/i.test(txt)) {
            if (!this._nonceRefreshPromise) {
              this._nonceRefreshPromise = (async () => {
                try {
                  const r = await fetch(`${BASE}/authenticate`, { method: 'GET', headers: { Accept: 'application/json' } });
                  const chal2 = r.headers.get('www-authenticate');
                  if (chal2) this.digestAuth.setChallenge(chal2);
                } finally {
                  setTimeout(() => { this._nonceRefreshPromise = null; }, 100);
                }
              })();
            }
            await this._nonceRefreshPromise;
            headers['Authorization'] = await this.digestAuth.buildAuthorizationHeader(method, authUri);
            resp = await fetch(url, { method, headers, body: payload });
          }
        }
      }

      if (resp.status === 204) return null;
      if (resp.status >= 400) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${(txt||'').substring(0,200)}`);
      }
      const ctype = resp.headers.get('content-type') || '';
      if (ctype.includes('application/json')) {
        try { return await resp.json(); } catch { return null; }
      }
      const t = await resp.text().catch(() => '');
      try { return JSON.parse(t); } catch { return t; }
    }

    // -- AUTH --
    async login(username, password) {
      // Steg 1: Hämta clientId via users-client (prova flera pw-former)
      const pwHash = await __digestSha256Hex(password);
      const pwHA1 = await __digestSha256Hex(`${username}:ProjectPortal:${password}`);
      const candidates = [pwHA1, pwHash, password];
      let clientId = null;
      for (const cand of candidates) {
        try {
          const url = `${BASE}/users-client?${qs({ username, password: cand })}`;
          const r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
          if (!r.ok) continue;
          const data = await r.json().catch(() => null);
          if (Array.isArray(data) && data.length) {
            clientId = data[0].ClientId ?? data[0].Id ?? data[0].clientId;
            if (clientId) break;
          } else if (data && typeof data === 'object') {
            clientId = data.ClientId ?? data.clientId ?? data.DefaultClientId ?? data.Clients?.[0]?.ClientId;
            if (clientId) break;
          }
        } catch {}
      }
      if (!clientId) throw new Error('Kunde inte hitta clientId — kontrollera användarnamn/lösenord');

      // Steg 2: /authenticate för challenge
      const chalResp = await fetch(`${BASE}/authenticate`, { method: 'GET', headers: { Accept: 'application/json' } });
      if (chalResp.status === 401 || chalResp.status === 204) {
        const chal = chalResp.headers.get('www-authenticate');
        if (!chal) throw new Error('Inget challenge-header');
        this.digestAuth.setChallenge(chal);
      }

      // Steg 3: Sätt credentials och validera
      await this.digestAuth.setCredentials(username, password);
      this.digestAuth.clientId = clientId;

      const result = await this._request('GET', '/authenticate');
      // Spara ev. uppdaterat clientId/role från respons
      if (result && typeof result === 'object') {
        const cid = result.ClientId ?? result.clientId ?? result.CurrentClientId ?? result.Client?.Id;
        if (cid) this.digestAuth.clientId = cid;
        const role = result.RoleCode ?? result.Role;
        if (role) this.digestAuth.role = role;
      }
      return result;
    }

    logout() { this.digestAuth.clear(); }

    // -- Tid --
    async getTimeWeek(startDate, endDate) {
      const raw = await this._request('GET', '/time-manage', {
        query: { StartDate: startDate, EndDate: endDate, ShowSevenDays: true }
      });
      let data = raw;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      return data;
    }

    async createTime({ datum, tidkod, timeTypeId, category, userId, projectId, antal, text }) {
      const uid = Number(userId) || Number(this.digestAuth.cachedUserId);
      if (!uid) throw new Error('UserId saknas — gå in i Tid-fliken först så hämtas det');
      const code = String(tidkod || '').substring(0, 3);
      const baseBatch = {
        ActualTimeRequests: [], AbsenceTimeRequests: [], ClaimsTimeRequests: [],
        DeletedActualTimeIds: [], DeletedAbsenceTimeIds: [], DeletedClaimsTimeIds: [],
        UserId: uid, Timestamp: datum,
      };
      const pid = Number(projectId);
      const ttId = timeTypeId != null ? Number(timeTypeId) : 0;

      if (category === 'actual' || (!category && ['010','011','030','031'].includes(code))) {
        const body = { ...baseBatch, ActualTimeRequests: [{
          ProjectId: pid, ProjectTaskId: 0, TimeTypeId: ttId,
          Billable: true, DeviationId: 0, Quantity: Number(antal) || 0,
          InvoiceQuantity: Number(antal) || 0, Comment: text || '', InvoiceAble: true,
        }] };
        return this._request('POST', '/actual-times/multiple', { body });
      }
      if (category === 'claims' || code === '020') {
        const body = { ...baseBatch, ClaimsTimeRequests: [{
          ProjectId: pid, ProjectTaskId: 0, TimeTypeId: ttId || 20,
          Quantity: Number(antal) || 0, Comment: text || '',
        }] };
        return this._request('POST', '/actual-times/multiple', { body });
      }
      if (category === 'absence' || ['040','050','060'].includes(code)) {
        const absMap = { '040': 1, '050': 2, '060': 3 };
        const body = { ...baseBatch, AbsenceTimeRequests: [{
          AbsenceTypeId: absMap[code] || 0, TimeTypeId: ttId || undefined,
          Hours: Number(antal) || 0, Quantity: Number(antal) || 0, Comment: text || '',
        }] };
        return this._request('POST', '/actual-times/multiple', { body });
      }
      throw new Error('Okänd tidkod: ' + tidkod);
    }

    async getTimeTypes() {
      const data = await this._request('GET', '/time-types/client');
      return Array.isArray(data) ? data : [];
    }

    // -- Ordrar --
    async listServiceOrders({ tabIndex = 8, startRow = 0, endRow = 100, keyword = '' } = {}) {
      const body = {
        SortModel: [], StartRow: startRow, EndRow: endRow,
        FilterModel: {}, TabIndex: tabIndex, Keyword: keyword,
      };
      return this._request('POST', '/service-order/list', { body });
    }

    async getProject(id) {
      return this._request('GET', `/projects/${encodeURIComponent(id)}`);
    }

    // -- Material / bilzoner --
    async getOrderMaterials(projectId, { skipFallback = true } = {}) {
      const body = {
        StartRow: 0, EndRow: 200, ProjectId: String(projectId),
        FilterModel: {}, SortModel: [], RowGroupCols: [], ValueCols: [],
        PivotCols: [], PivotMode: false, GroupKeys: [], Keyword: '',
      };
      const primary = await this._request('POST', '/projects/reported-user-materials', { body }).catch(() => null);
      const rows = Array.isArray(primary) ? primary : (primary?.Rows || primary?.rows || []);
      return { rows, projectId: Number(projectId) };
    }

    async searchSnabbvalArticles({ articleGroupId = 7122, top = 50, keyword = '' } = {}) {
      const query = {
        ClientId: this.digestAuth.clientId,
        UserId: this.digestAuth.cachedUserId || 0,
        Keyword: keyword, Top: top, PageIndex: 1,
        ArticleGroupId: articleGroupId, ShowCost: true, PriceListId: 0,
      };
      return this._request('GET', '/search/articles/search', { query });
    }

    async getArticleSalesPrice(articleId, projectId) {
      this._projectPriceLists = this._projectPriceLists || new Map();
      let plId = this._projectPriceLists.get(String(projectId));
      if (!plId) {
        try {
          const proj = await this._request('GET', `/projects/${encodeURIComponent(projectId)}`);
          plId = proj?.PriceListId || 0;
          this._projectPriceLists.set(String(projectId), plId);
        } catch {}
      }
      return this._request('GET', `/articles/${encodeURIComponent(articleId)}/salesprice/${Number(plId)||0}/0`);
    }

    async addMaterial({ projectId, articleId, articleNumber, benamning, antal, enhet, prisPerEnhet, materialUnitId, purchasePrice, discount }) {
      const uid = Number(this.digestAuth.cachedUserId);
      if (!uid) throw new Error('UserId saknas — öppna Tid-fliken först');
      // Auto-resolva ProjectTaskId
      let ptId = 0, tType = 1;
      try {
        const tasks = await this._request('GET', `/${encodeURIComponent(projectId)}/tasks-deviations/materials`);
        const first = Array.isArray(tasks) ? tasks.find(t => t.ProjectTaskId) : null;
        if (first?.ProjectTaskId) { ptId = first.ProjectTaskId; tType = first.TaskType || 1; }
      } catch {}
      const price = Number(prisPerEnhet) || 0;
      const qty = Number(antal) || 0;
      const body = {
        ActualAndExpectedMaterialRequests: [{
          Name: benamning || '',
          Total: price * qty,
          MaterialUnitId: Number(materialUnitId) || 0,
          ArticleId: Number(articleId) || 0,
          InvoiceAble: true,
          ArticleNumber: articleNumber || '',
          Discount: Number(discount) || 0,
          CreateDate: new Date().toISOString().slice(0, 10),
          ReportQty: qty, ReportInvoiceQty: qty, BudgetQty: qty,
          Price: price, CostPrice: '',
          GrossPrice: null, PurchasePrice: Number(purchasePrice) || price,
          WholeSaleId: 0,
        }],
        DeleteActualMaterialIds: [],
        ProjectId: Number(projectId), ProjectTaskId: ptId, TaskType: tType, UserId: uid,
      };
      return this._request('POST', '/materials', { body });
    }
  }

  global.PPClient = PPClient;
})(window);
