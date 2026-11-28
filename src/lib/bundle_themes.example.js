'use strict';
/**
 * ÖRNEK paket teması (açık depo için). Kendi temalarını bundle_themes.local.js'e yaz (aynı yapı: { THEMES }); o dosya GitHub'a gitmez.
 * match: hangi ürünler (niş/kimlik), season: ek filtre, max/min: tasarım sayısı, cover: kapak yazıları, colors: kapak renkleri.
 */
const THEMES = {
  example: {
    match: /christmas/i, max: 20, min: 12, price: 99.99,
    cover: ['Example Christmas', 'PNG Bundle'],
    colors: { bg: '#1f3a2e', band: '#7a1f1f', light: '#f6efe3', light2: '#efe6d6', accent: '#f3d9a4' },
    keyword: 'christmas png bundle', subjects: ['christmas'],
    title: (n) => `${n} Example Christmas PNG Bundle, Example Sublimation Designs`,
    intro: (n) => `${n} example Christmas PNG designs in one bundle.`,
    tags: ['example tag 1', 'example tag 2', 'example tag 3', 'example tag 4', 'example tag 5', 'example tag 6', 'example tag 7', 'example tag 8', 'example tag 9', 'example tag 10', 'example tag 11', 'example tag 12', 'example tag 13'],
  },
};
module.exports = { THEMES };
