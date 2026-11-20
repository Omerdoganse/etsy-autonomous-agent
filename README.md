# Etsy Autonomous Agent

> Dijital ürün (tişört PNG tasarımı) üretiminden Etsy'de yayına kadar uçtan uca otomasyon ve masaüstü kontrol paneli.
> *An end-to-end automation + desktop control panel that designs, packages and lists digital t-shirt PNG products on Etsy.*

Bu depo projenin **vitrin** sürümüdür: mimari ve kod mantığı açıktır; API anahtarları, oturumlar, mağaza bilgileri ve iş stratejisi verileri (tasarım promptları, başlık/etiket setleri, fiyatlar) depoda **yoktur**. Bunların yerine çalışan **örnek** dosyalar bulunur.

---

## Ne yapar?

| Adım | Açıklama |
|---|---|
| 🔎 Trend bulma | Yaklaşan özel günleri (Noel, Şükran Günü…) ve Etsy/Google arama önerilerini tarayıp niş seçer |
| 🎨 Tasarım üretimi | Ücretsiz **Gemini** (tarayıcı otomasyonu) veya Replicate/OpenAI ile 4'lü tasarım setleri çizdirir; konu, stil, palet ve kompozisyon her seferinde çeşitlendirilir |
| ✂️ Temizleme | Magenta zeminden şeffaf PNG kesimi, kenar/pembe artık temizliği, 4500×5400 @300 DPI büyütme, retro halftone efektleri |
| 👕 Vitrin | Gerçek fotoğraf mockup'ları (modelli tişört, kupa), kapak görseli, tüm tasarımlar kolajı, bilgi görselleri ve 6 sn tanıtım videosu |
| 📝 SEO | Etsy kurallarına uygun başlık (≤140 kr.) ve 13 etiket (≤20 kr.), marka/telif kelimesi filtresi, açıklama |
| ✅ Kalite kontrol | Çözünürlük, şeffaflık, beyaz kenar, kopya tasarım ve dosya boyutu denetimi |
| 📦 Paketleme | ZIP (20 MB sınırı → parçalı ZIP veya Google Drive teslimatı + PDF talimat) |
| 🛒 Etsy'ye yükleme | Playwright ile ilan editörünü doldurur (fotoğraf, video, dosya, etiket, kategori); toplu yükleme, mevcut ilanların görsel/SEO güncellemesi |
| 🖥 Kontrol paneli | Electron masaüstü uygulaması: ürün listesi, inceleme, beyaz silgi, toplu üretim/yükleme, zamanlayıcı, fiyat hesaplayıcı |
| ⏰ Zamanlama | Windows Görev Zamanlayıcı ile günlük otomatik üretim; panel kapalıyken bırakılan istekleri de işler |

## Mimari

```
gui/                Electron paneli (main.js = pencere + worker yönetimi, renderer.js = arayüz)
src/
  index.js          Worker: iş kuyruğu, IPC komutları, uzaktan istek dosyaları, zamanlanmış çalıştırma
  01_trend_scout.js Niş/trend seçimi (etkinlik takvimi + arama önerileri)
  02_asset_generator.js  Görsel üretimi, zemin silme, büyütme, efektler
  03_mockup_engine.js    Mockup, kapak, kolaj, video
  04_seo_engine.js       Başlık / etiket / açıklama + doğrulama
  05_etsy_publisher.js   Etsy yükleme (Playwright veya resmi API v3)
  06_quality_check.js    Kalite kontrol raporu
  lib/
    gemini_browser.js    Gemini'ye tarayıcıdan ücretsiz görsel çizdirme
    design_variety.js    Prompt üretici (veriler design_presets.*.js'ten)
    bestseller_sets.js   "Çok satan kalıbı" setleri (veriler bestseller_sets.*.js'ten)
    etsy_*.js            Mevcut ilanlarda medya / SEO / dosya / kapak güncelleme
    mega_bundle.js       Büyük paket + Google Drive teslimatı
    core.js, db.js ...   Ayarlar, log, SQLite/JSON veritabanı, yardımcılar
data/  (gitignore)  Oturumlar, veritabanı, mockup şablonları, istek dosyaları (*_request.json)
output/ (gitignore) Üretilen ürün klasörleri
```

**Uzaktan istek dosyaları:** Panel açıkken `data/` içine bırakılan `publish_request.txt`, `bs_request.json`, `seo_request.json`, `media_request.json` gibi dosyalar worker tarafından okunup işlenir (panel kapalıysa bir sonraki zamanlanmış çalıştırmada).

## Kurulum

```bash
npm install
cp .env.example .env                 # anahtarları doldur (Gemini yolu için zorunlu değil)
cp config.example.json config.json   # mağaza adı, fiyat, zamanlama
# İsteğe bağlı: kendi içerik verilerin
cp src/lib/design_presets.example.js  src/lib/design_presets.local.js
cp src/lib/bestseller_sets.example.js src/lib/bestseller_sets.local.js
npm run setup   # mockup şablonları
npm run gui     # kontrol paneli
```

Windows'ta `Baslat.bat` bunların hepsini yapar. `*.local.js` dosyaları varsa onlar, yoksa örnek dosyalar kullanılır; `.local` dosyaları git'e gönderilmez.

## Uyarılar

- Etsy'nin [satıcı kurallarına](https://www.etsy.com/legal/sellers/) ve otomasyon/yapay zekâ açıklama şartlarına uymak kullanıcının sorumluluğundadır. Varsayılan olarak ilanlar **taslak** yüklenir.
- Telifli/markalı karakter, film, şarkı ve logo kullanmayın; SEO motoru bilinen marka kelimelerini filtreler ama nihai kontrol sizdedir.
- Bu depo eğitim/portfolyo amaçlıdır.

---

*English summary:* Node.js + Playwright + Electron pipeline that picks a seasonal niche, generates 4-design PNG bundles (free Gemini browser automation or paid APIs), cleans them to transparent 300-DPI files, renders photo mockups and a promo video, writes Etsy-compliant SEO, runs QC, packages ZIPs and uploads listings via browser automation. Secrets, shop data and the real prompt/strategy datasets are kept out of the repo (`*.local.js`, `.env`, `config.json`, `data/`); example versions are provided.
