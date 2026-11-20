'use strict';
/** Replicate tahmin (prediction) çalıştırıcı: senkron bekleme + 429 geri çekilme + durum yoklama. */
const { log, checkStop, sleep } = require('./core');
const { http } = require('./http');

async function replicateRun(model, input, cfg = {}) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw Object.assign(new Error('REPLICATE_API_TOKEN .env içinde tanımlı değil'), { noRetry: true });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' };
  const [owner, nameVer] = model.split('/');
  const [name, version] = nameVer.split(':');
  const url = version ? 'https://api.replicate.com/v1/predictions' : `https://api.replicate.com/v1/models/${owner}/${name}/predictions`;
  const body = version ? { version, input } : { input };
  // Düşük bakiyeli Replicate hesapları dakikada ~6 istekle sınırlı → 429'da bekleyip yeniden dene
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await http.post(url, body, { headers, timeout: 90000 });
      break;
    } catch (e) {
      const st = e.response && e.response.status;
      if (st === 402) throw Object.assign(new Error('Replicate kredisi bitti (402) — replicate.com/account/billing adresinden kredi yükleyin'), { noRetry: true, fatal: true });
      if (st !== 429 || attempt >= 6) throw e;
      const ra = Number((e.response.headers && (e.response.headers['retry-after'] || e.response.headers['Retry-After'])) || 0);
      const wait = Math.max(ra * 1000, 10000 + attempt * 5000);
      log(`Replicate istek sınırı (429) — ${Math.round(wait / 1000)} sn bekleniyor`, 'warn');
      checkStop();
      await sleep(wait);
    }
  }
  let pred = res.data;
  const started = Date.now();
  while (['starting', 'processing'].includes(pred.status)) {
    checkStop();
    if (Date.now() - started > 5 * 60000) throw new Error(`Replicate zaman aşımı (${model})`);
    await sleep(2000);
    res = await http.get(pred.urls.get, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    pred = res.data;
  }
  if (pred.status !== 'succeeded') throw new Error(`Replicate ${model} başarısız: ${pred.error || pred.status}`);
  if (cfg.raw) return pred.output; // metin modelleri: tüm çıktı (token dizisi)
  const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
  if (!out) throw new Error(`Replicate ${model} boş çıktı döndürdü`);
  return typeof out === 'string' ? out : out.url || out.image;
}


module.exports = { replicateRun };
