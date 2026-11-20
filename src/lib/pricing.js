'use strict';
/**
 * Fiyat ve tahmini kâr hesabı (Etsy Türkiye satıcı ücretleri).
 * Oranlar config.json → fees altında değiştirilebilir; Etsy ücretlerini değiştirirse buradan güncellenir.
 */
const DEFAULT_FEES = {
  usd_try: 42,              // listeleme ücreti dolar olduğu için kur (tahmini)
  listing_usd: 0.2,         // her listeleme/yenileme ve her satışta otomatik yenileme
  transaction_pct: 6.5,     // işlem ücreti
  processing_pct: 6.5,      // ödeme işleme ücreti (yüzde)
  processing_fixed: 3,      // ödeme işleme sabit kısmı (TL)
  regulatory_pct: 2.27,     // Türkiye düzenleyici işletim ücreti
  fee_vat_pct: 20,          // Etsy ücretlerine eklenen KDV
  buyer_vat_pct: 20,        // Türkiye'deki alıcının gördüğü fiyata eklenen KDV
};

function fees(cfg) { return { ...DEFAULT_FEES, ...((cfg && cfg.fees) || {}) }; }

const r2 = (x) => Math.round(x * 100) / 100;

/** Bir satıştan elinde kalan tahmini tutar. price: Etsy'deki fiyat (KDV hariç), discountPct: indirim yüzdesi */
function calcProfit(price, discountPct = 0, cfg = {}) {
  const f = fees(cfg);
  const sale = r2(Number(price) * (1 - (Number(discountPct) || 0) / 100));
  const listing = r2(f.listing_usd * f.usd_try);
  const transaction = r2(sale * f.transaction_pct / 100);
  const processing = r2(sale * f.processing_pct / 100 + f.processing_fixed);
  const regulatory = r2(sale * f.regulatory_pct / 100);
  const base = listing + transaction + processing + regulatory;
  const vat = r2(base * f.fee_vat_pct / 100);
  const totalFees = r2(base + vat);
  const net = r2(sale - totalFees);
  return {
    price: r2(Number(price)), discountPct: Number(discountPct) || 0, sale,
    buyerSees: r2(sale * (1 + f.buyer_vat_pct / 100)),
    fees: { listing, transaction, processing, regulatory, vat, total: totalFees },
    net, marginPct: sale > 0 ? Math.round((net / sale) * 100) : 0,
  };
}

module.exports = { calcProfit, DEFAULT_FEES, fees };
