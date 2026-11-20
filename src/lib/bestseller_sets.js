'use strict';
/** Çok satan kalıbı setleri yükleyicisi: gerçek (gizli) bestseller_sets.local.js varsa onu, yoksa açık örnek dosyayı kullanır. */
let sets;
try { sets = require('./bestseller_sets.local'); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !/bestseller_sets\.local/.test(e.message)) throw e;
  sets = require('./bestseller_sets.example');
}
module.exports = sets;
