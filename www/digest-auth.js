/**
 * Browser-port av HTTP Digest Auth (SHA-256 + Projektportalens custom formel).
 *
 * Skillnader mot Node-versionen:
 *   - Använder Web Crypto SubtleCrypto istället för node:crypto
 *   - Alla hash-funktioner är async (Promise-baserade)
 *   - buildAuthorizationHeader är async (await:as vid anrop)
 *
 * Projektportalens quirks (verifierat från webb-appen):
 *   - algorithm=SHA-256 (ej annonserad i challenge)
 *   - HA1 = SHA256( user : realm : SHA256(password) ) — dubbelhashning
 *   - response = SHA256( ha1 : nonce : nc : cnonce : qop : ha2 : clientId )
 *   - Authorization-fält i specifik ordning (kritiskt)
 */

(function (global) {
  'use strict';

  const enc = new TextEncoder();

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function parseChallenge(header) {
    if (!header) return {};
    const s = header.replace(/^Digest\s+/i, '');
    const out = {};
    const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,]+))/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      out[m[1].toLowerCase()] = (m[2] !== undefined ? m[2] : m[3]).trim();
    }
    return out;
  }

  class DigestAuth {
    constructor() {
      this.username = null;
      this.ha1 = null;         // SHA256(user:realm:SHA256(password))
      this.realm = 'ProjectPortal';
      this.nonce = null;
      this.qop = 'auth';
      this.opaque = null;
      this.clientId = null;
      this.role = null;
      this._nc = 0;
      this.cachedUserId = null;
    }

    async setCredentials(username, password) {
      this.username = username;
      // HA1 = SHA256( user : realm : SHA256(password) )
      const pwHash = await sha256Hex(password);
      this.ha1 = await sha256Hex(`${username}:${this.realm}:${pwHash}`);
    }

    setChallenge(wwwAuth) {
      const p = parseChallenge(wwwAuth);
      if (p.realm) this.realm = p.realm;
      if (p.nonce) this.nonce = p.nonce;
      if (p.opaque) this.opaque = p.opaque;
      if (p.qop) this.qop = p.qop.split(/\s*,\s*/)[0];
      this._nc = 0;
    }

    _randCnonce() {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async buildAuthorizationHeader(method, uri) {
      if (!this.ha1 || !this.nonce || !this.clientId) {
        throw new Error('Digest auth inte redo (ha1/nonce/clientId saknas)');
      }
      this._nc += 1;
      const nc = this._nc.toString(16).padStart(8, '0');
      const cnonce = this._randCnonce();
      const ha2 = await sha256Hex(`${method}:${uri}`);
      // response = SHA256( ha1 : nonce : nc : cnonce : qop : ha2 : clientId )
      const response = await sha256Hex(
        `${this.ha1}:${this.nonce}:${nc}:${cnonce}:${this.qop}:${ha2}:${this.clientId}`
      );
      const userHash = await sha256Hex(this.username);
      const userEnc = encodeURIComponent(this.username);
      // Fält i verifierad ordning
      return 'Digest ' +
        `username="${userEnc}",` +
        `userHash="${userHash}",` +
        `realm="${this.realm}",` +
        `nonce="${this.nonce}",` +
        `uri="${uri}",` +
        `response="${response}",` +
        `qop=${this.qop},` +
        `nc=${nc},` +
        `cnonce="${cnonce}",` +
        `clientId=${this.clientId}`;
    }

    toJSON() {
      return {
        username: this.username,
        ha1: this.ha1,
        realm: this.realm,
        nonce: this.nonce,
        qop: this.qop,
        opaque: this.opaque,
        clientId: this.clientId,
        role: this.role,
        nc: this._nc,
        cachedUserId: this.cachedUserId,
      };
    }

    fromJSON(obj) {
      if (!obj) return;
      this.username = obj.username || null;
      this.ha1 = obj.ha1 || null;
      this.realm = obj.realm || 'ProjectPortal';
      this.nonce = obj.nonce || null;
      this.qop = obj.qop || 'auth';
      this.opaque = obj.opaque || null;
      this.clientId = obj.clientId || null;
      this.role = obj.role || null;
      this._nc = Number(obj.nc) || 0;
      this.cachedUserId = obj.cachedUserId || null;
    }

    clear() {
      this.username = null;
      this.ha1 = null;
      this.nonce = null;
      this.opaque = null;
      this.clientId = null;
      this.role = null;
      this._nc = 0;
      this.cachedUserId = null;
    }
  }

  global.DigestAuth = DigestAuth;
  global.__digestSha256Hex = sha256Hex;
})(window);
