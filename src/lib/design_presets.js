'use strict';
/** Tasarım içerik verileri yükleyicisi: gerçek (gizli) design_presets.local.js varsa onu, yoksa açık örnek dosyayı kullanır. */
let presets;
try { presets = require('./design_presets.local'); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !/design_presets\.local/.test(e.message)) throw e;
  presets = require('./design_presets.example');
}
module.exports = presets;
