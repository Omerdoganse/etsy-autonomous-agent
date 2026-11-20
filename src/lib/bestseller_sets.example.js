'use strict';
/**
 * ÖRNEK "çok satan kalıbı" set tanımı (açık depo için).
 * Gerçek setlerini bestseller_sets.local.js dosyasına yaz (aynı yapı: { SETS }); o dosya GitHub'a gönderilmez.
 * Her set: keyword, Gemini talimatları [etiket, prompt, { subject, note }], isteğe bağlı hazır SEO (başlık + 13 etiket).
 */
const BG = 'Background: a perfectly flat, solid, uniform magenta background (pure #FF00FF) filling the whole image edge to edge.';
const RULES = 'Do not use magenta inside the artwork. Artwork only, centered, clean sharp edges. No text unless given. Original design only: no trademarked characters or logos.';
const P = (desc) => `Create a high-resolution t-shirt print design.\n${desc}\n${BG}\n${RULES}`;

const SETS = {
  example_set: {
    keyword: 'example christmas png',
    items: [
      ['Örnek 1', P('Design: a cute illustrated pine tree with a few ornaments. No text.'), { subject: 'pine tree', note: 'Example pine tree' }],
      ['Örnek 2', P('Design: a simple snowman with a scarf. No text.'), { subject: 'snowman', note: 'Example snowman' }],
    ],
    seo: {
      title: 'Example Christmas PNG Bundle, Example Sublimation Design, Example Shirt Graphic',
      tags: ['example tag 1', 'example tag 2', 'example tag 3', 'example tag 4', 'example tag 5', 'example tag 6', 'example tag 7', 'example tag 8', 'example tag 9', 'example tag 10', 'example tag 11', 'example tag 12', 'example tag 13'],
    },
  },
};

module.exports = { SETS };
