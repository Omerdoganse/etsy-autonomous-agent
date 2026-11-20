'use strict';
/**
 * HTTP istemcisi: axios kuruluysa onu döndürür; değilse fetch tabanlı, axios ile
 * uyumlu küçük bir alt küme (get/post/put/patch, params, headers, timeout, responseType).
 */
let client;
try {
  client = require('axios');
} catch {
  async function request(method, url, data, opts = {}) {
    const u = new URL(url);
    if (opts.params) for (const [k, v] of Object.entries(opts.params)) if (v !== undefined) u.searchParams.set(k, v);
    const headers = { ...(opts.headers || {}) };
    let body = data;
    if (data && typeof data === 'object' && !(data instanceof Buffer) && !(data instanceof URLSearchParams)
        && typeof data.getBuffer !== 'function' && !(typeof FormData !== 'undefined' && data instanceof FormData)) {
      body = JSON.stringify(data);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (data && typeof data.getBuffer === 'function') {
      Object.assign(headers, data.getHeaders());
      body = data.getBuffer();
    }
    const ctrl = new AbortController();
    const timer = opts.timeout ? setTimeout(() => ctrl.abort(), opts.timeout) : null;
    try {
      const res = await fetch(u, { method: method.toUpperCase(), headers, body, signal: ctrl.signal });
      let payload;
      if (opts.responseType === 'arraybuffer') payload = Buffer.from(await res.arrayBuffer());
      else {
        const text = await res.text();
        try { payload = JSON.parse(text); } catch { payload = text; }
      }
      const response = { status: res.status, data: payload, headers: Object.fromEntries(res.headers.entries()) };
      if (res.status >= 400) {
        const err = new Error(`Request failed with status code ${res.status}`);
        err.response = response;
        throw err;
      }
      return response;
    } finally { if (timer) clearTimeout(timer); }
  }
  client = {
    get: (url, opts) => request('get', url, undefined, opts),
    delete: (url, opts) => request('delete', url, undefined, opts),
    post: (url, data, opts) => request('post', url, data, opts),
    put: (url, data, opts) => request('put', url, data, opts),
    patch: (url, data, opts) => request('patch', url, data, opts),
  };
}

/** Ağdan dosya indirip Buffer döndürür. */
async function download(url, timeout = 120000) {
  const res = await client.get(url, { responseType: 'arraybuffer', timeout });
  return Buffer.from(res.data);
}

/** Bir hata nesnesinden okunabilir mesaj çıkarır. */
function describeError(err) {
  if (err && err.response) {
    const d = err.response.data;
    const body = typeof d === 'string' ? d.slice(0, 300) : JSON.stringify(d).slice(0, 300);
    return `HTTP ${err.response.status}: ${body}`;
  }
  return err && err.message ? err.message : String(err);
}

module.exports = { http: client, download, describeError };
