'use strict';
/**
 * Bulut depolama yükleyici: S3 uyumlu her servis (AWS S3, Cloudflare R2, Backblaze B2, Wasabi).
 * Bağımlılık gerektirmeyen AWS Signature V4 ile PUT yükleme + indirme bağlantısı üretimi.
 *
 * .env:
 *   CLOUD_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com   (AWS için: https://s3.<region>.amazonaws.com)
 *   CLOUD_REGION=auto            (R2 için "auto", AWS için ör. "eu-central-1")
 *   CLOUD_BUCKET=etsy-deliveries
 *   CLOUD_ACCESS_KEY_ID=...
 *   CLOUD_SECRET_ACCESS_KEY=...
 *   CLOUD_PUBLIC_BASE_URL=https://files.senindomainin.com   (kalıcı link için önerilir; boşsa süreli imzalı link)
 */
const fs = require('fs');
const crypto = require('crypto');
const { http } = require('./http');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const encodeKey = (key) => key.split('/').map((p) => encodeURIComponent(p)).join('/');

function cloudConfigured() {
  const e = process.env;
  return !!(e.CLOUD_ENDPOINT && e.CLOUD_BUCKET && e.CLOUD_ACCESS_KEY_ID && e.CLOUD_SECRET_ACCESS_KEY);
}

function signingKey(secret, date, region) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function amzDates() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

async function uploadFile(localPath, key, contentType = 'application/zip') {
  if (!cloudConfigured()) throw Object.assign(new Error('Bulut depolama .env içinde tanımlı değil (CLOUD_*)'), { noRetry: true });
  const e = process.env;
  const region = e.CLOUD_REGION || 'auto';
  const endpoint = new URL(e.CLOUD_ENDPOINT);
  const host = endpoint.host;
  const canonicalUri = `/${e.CLOUD_BUCKET}/${encodeKey(key)}`;
  const body = fs.readFileSync(localPath);
  const payloadHash = sha256hex(body);
  const { amzDate, date } = amzDates();
  const headers = { host, 'content-type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(e.CLOUD_SECRET_ACCESS_KEY, date, region), stringToSign).toString('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${e.CLOUD_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const reqHeaders = { 'Content-Type': contentType, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, Authorization: auth };
  await http.put(`${endpoint.origin}${canonicalUri}`, body, { headers: reqHeaders, timeout: 600000, maxBodyLength: Infinity, maxContentLength: Infinity });
  return downloadUrl(key);
}

/** Kalıcı public URL (CLOUD_PUBLIC_BASE_URL) ya da en fazla 7 günlük imzalı GET bağlantısı. */
function downloadUrl(key, expiryDays = 7) {
  const e = process.env;
  if (e.CLOUD_PUBLIC_BASE_URL) return `${e.CLOUD_PUBLIC_BASE_URL.replace(/\/$/, '')}/${encodeKey(key)}`;
  const region = e.CLOUD_REGION || 'auto';
  const endpoint = new URL(e.CLOUD_ENDPOINT);
  const { amzDate, date } = amzDates();
  const scope = `${date}/${region}/s3/aws4_request`;
  const expires = Math.min(604800, Math.max(60, Math.round(expiryDays * 86400)));
  const canonicalUri = `/${e.CLOUD_BUCKET}/${encodeKey(key)}`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${e.CLOUD_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(q).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k])}`).join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${endpoint.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const sig = hmac(signingKey(e.CLOUD_SECRET_ACCESS_KEY, date, region), stringToSign).toString('hex');
  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

module.exports = { cloudConfigured, uploadFile, downloadUrl };
