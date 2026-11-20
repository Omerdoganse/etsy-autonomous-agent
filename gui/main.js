'use strict';
/**
 * Electron ana süreç + IPC köprüsü.
 * - Üretim motoru (src/index.js --ipc) ayrı bir Node sürecinde çalışır: arayüz donmaz, "Durdur" güvenli çalışır.
 * - Panel içi zamanlayıcı: config.schedule (gün/saat/adet) — pencere kapansa da tepside çalışmaya devam eder.
 * - Windows Görev Zamanlayıcı: panelden tek tıkla görev kurar/kaldırır (panel kapalıyken bile üretim).
 * - Bildirimler, sistem tepsisi, küçük resimler (nativeImage → data URL).
 */
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DATA = path.join(ROOT, 'data');
const SCHEDULE_STATE = path.join(DATA, 'schedule_state.json');
const ACTIVITY_LOG = path.join(ROOT, 'logs', 'activity.log');
const TASK_NAME = 'EtsyOtonomFabrika';
const ICON = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

let win = null;
let tray = null;
let worker = null;
let reqId = 0;
const pending = new Map();
let quitting = false;
let workerReady = false;
let workerBusy = { busy: false };
let trayHintShown = false;

/* ======================================================================
 * İşçi (motor) süreci
 * ==================================================================== */
let NODE_CMD = null;
function nodeBinary() {
  if (NODE_CMD) return NODE_CMD;
  // Görev Zamanlayıcı ve işçi için mutlak node.exe yolu
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
    const p = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /node\.exe$/i.test(s) && fs.existsSync(s));
    if (p) return (NODE_CMD = { cmd: p, env: {} });
  } else {
    const r = spawnSync('node', ['-v'], { encoding: 'utf8' });
    if (r.status === 0) return (NODE_CMD = { cmd: 'node', env: {} });
  }
  // Yedek: Electron'un kendi Node çalışma zamanı
  return (NODE_CMD = { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
}

function emit(event, data) { if (win && !win.isDestroyed()) win.webContents.send('worker-event', { event, data }); }

/* Kod güncellenince (ör. uzaktan düzeltme) paneli kapatıp açmaya gerek kalmasın:
 * src/ değişirse motor boşta olduğunda yeniden başlatılır, gui/ değişirse arayüz yenilenir. */
function watchForUpdates() {
  let srcDirty = false, guiDirty = false, t = null;
  const kick = () => {
    clearTimeout(t);
    t = setTimeout(function apply() {
      if (srcDirty) {
        if (workerBusy.busy) { t = setTimeout(apply, 5000); return; }
        srcDirty = false;
        emit('log', { ts: new Date().toISOString(), level: 'info', msg: 'Güncelleme algılandı — motor yenileniyor…' });
        try { worker.kill(); } catch { /* yok say */ } // exit olayı motoru yeniden başlatır
      }
      if (guiDirty) {
        if (workerBusy.busy) { t = setTimeout(apply, 5000); return; }
        guiDirty = false;
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }
    }, 2500);
  };
  const watch = (dir, onChange) => {
    try { fs.watch(dir, { recursive: true }, (ev, f) => { if (f && /\.(js|json|html|css)$/.test(f) && !/node_modules/.test(f)) { onChange(); kick(); } }); } catch { /* yok say */ }
  };
  watch(path.join(ROOT, 'src'), () => { srcDirty = true; });
  watch(path.join(ROOT, 'gui'), () => { guiDirty = true; });
}

function startWorker() {
  const { cmd, env } = nodeBinary();
  worker = spawn(cmd, [path.join(ROOT, 'src', 'index.js'), '--ipc'], {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    shell: false,
  });
  workerReady = false;
  worker.on('message', (m) => {
    if (m && m.event === 'ready') workerReady = true;
    if (m && m.event === 'busy') { workerBusy = m.data; updateTray(); }
    if (m && m.event === 'done') notifyDone(m.data);
    if (m && m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      return m.ok ? resolve(m.data) : reject(new Error(m.error));
    }
    if (m && m.event) emit(m.event, m.data);
  });
  const pipeOut = (level) => (buf) => {
    for (const line of String(buf).split(/\r?\n/).filter(Boolean)) emit('log', { ts: new Date().toISOString(), level, msg: line });
  };
  worker.stdout.on('data', pipeOut('info'));
  worker.stderr.on('data', pipeOut('error'));
  worker.on('exit', (code) => {
    workerReady = false;
    workerBusy = { busy: false };
    for (const { reject } of pending.values()) reject(new Error('Motor süreci kapandı'));
    pending.clear();
    emit('busy', { busy: false });
    if (!quitting) {
      emit('log', { ts: new Date().toISOString(), level: 'warn', msg: `Motor süreci kapandı (kod ${code}), yeniden başlatılıyor...` });
      setTimeout(startWorker, 1500);
    }
  });
}

function callWorker(type, payload, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    if (!worker || !worker.connected) return reject(new Error('Motor hazır değil'));
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.send({ id, type, payload });
    if (timeoutMs) setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Zaman aşımı')); } }, timeoutMs);
  });
}

/* ======================================================================
 * Ayarlar (.env + config.json)
 * ==================================================================== */
const ENV_KEYS = ['REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'ETSY_API_KEY', 'ETSY_SHARED_SECRET', 'ETSY_SHOP_ID',
  'CLOUD_ENDPOINT', 'CLOUD_REGION', 'CLOUD_BUCKET', 'CLOUD_ACCESS_KEY_ID', 'CLOUD_SECRET_ACCESS_KEY', 'CLOUD_PUBLIC_BASE_URL'];

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) return out;
  for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function writeEnv(values) {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const done = new Set();
  const updated = lines.map((raw) => {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(values, m[1])) { done.add(m[1]); return `${m[1]}=${values[m[1]] ?? ''}`; }
    return raw;
  });
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) updated.push(`${k}=${v ?? ''}`);
  fs.writeFileSync(ENV_PATH, updated.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeConfig(patch) {
  const merged = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

/* ======================================================================
 * Panel içi zamanlayıcı
 * ==================================================================== */
const DEFAULT_SCHEDULE = { enabled: false, times: ['10:00'], days: [1, 2, 3, 4, 5, 6, 0], count: 3 };
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function getSchedule() { return { ...DEFAULT_SCHEDULE, ...(readConfig().schedule || {}) }; }
function readState() { try { return JSON.parse(fs.readFileSync(SCHEDULE_STATE, 'utf8')); } catch { return { done: {} }; } }
function writeState(s) {
  // 14 günden eski kayıtları temizle
  const cutoff = dayKey(new Date(Date.now() - 14 * 86400000));
  for (const k of Object.keys(s.done)) if (k.slice(0, 10) < cutoff) delete s.done[k];
  fs.writeFileSync(SCHEDULE_STATE, JSON.stringify(s, null, 2));
}

/** Bir sonraki planlı çalışma zamanı (panel içi) */
function nextRun(schedule = getSchedule(), from = new Date()) {
  if (!schedule.enabled || !schedule.times.length || !schedule.days.length) return null;
  const state = readState();
  for (let d = 0; d < 8; d++) {
    const day = new Date(from); day.setDate(day.getDate() + d);
    if (!schedule.days.includes(day.getDay())) continue;
    for (const t of [...schedule.times].sort()) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(day); at.setHours(h, m, 0, 0);
      const key = `${dayKey(at)} ${t}`;
      if (state.done[key]) continue;
      if (at.getTime() + 2 * 3600 * 1000 < from.getTime()) continue; // 2 saatten fazla kaçırılanlar atlanır
      return { at: at.toISOString(), key, label: at.toLocaleString('tr-TR', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' }) };
    }
  }
  return null;
}

let lastScheduleLog = '';
async function schedulerTick() {
  const schedule = getSchedule();
  updateTray();
  if (!schedule.enabled || !workerReady) return;
  const now = new Date();
  const nr = nextRun(schedule, now);
  if (!nr || new Date(nr.at) > now) return;
  if (workerBusy.busy) {
    if (lastScheduleLog !== nr.key) emit('log', { ts: now.toISOString(), level: 'warn', msg: `⏰ Planlı üretim (${nr.key}) için başka işlemin bitmesi bekleniyor...` });
    lastScheduleLog = nr.key;
    return;
  }
  const state = readState();
  state.done[nr.key] = new Date().toISOString();
  writeState(state);
  emit('log', { ts: now.toISOString(), level: 'success', msg: `⏰ Planlı üretim başlıyor (${nr.key}): ${schedule.count} ürün` });
  emit('schedule', { next: nextRun() });
  callWorker('run', { count: schedule.count, dryRun: false, publish: true, source: 'schedule' }).catch((e) => {
    emit('log', { ts: new Date().toISOString(), level: 'error', msg: `Planlı üretim başarısız: ${e.message}` });
  });
}

/* ======================================================================
 * Windows Görev Zamanlayıcı
 * ==================================================================== */
const DAY_TAGS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const dec = (b) => { try { return new TextDecoder('windows-1254').decode(b); } catch { return b.toString('utf8'); } };
      resolve({ ok: !err, code: err ? err.code : 0, out: dec(stdout || Buffer.alloc(0)), err: dec(stderr || Buffer.alloc(0)) });
    });
  });
}

function writeLauncher(count) {
  // Konsol penceresi açmadan çalıştıran VBScript başlatıcı; çıktı logs/scheduled.log'a yazılır
  const { cmd } = nodeBinary();
  const scripts = path.join(DATA, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const vbs = path.join(scripts, 'scheduled_run.vbs');
  const logFile = path.join(ROOT, 'logs', 'scheduled.log');
  const inner = `cmd /c cd /d ""${ROOT}"" && ""${cmd}"" ""${path.join(ROOT, 'src', 'index.js')}"" --count=${count} --scheduled >> ""${logFile}"" 2>&1`;
  fs.writeFileSync(vbs, `' Etsy Otonom Fabrika - scheduled production (auto-generated)\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.Run "${inner}", 0, True\r\n`, 'latin1');
  return vbs;
}

function taskXml({ times, days, count }) {
  const vbs = writeLauncher(count);
  const today = dayKey(new Date());
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  const dayXml = days.map((d) => `<${DAY_TAGS[d]} />`).join('');
  const triggers = times.map((t) => `
    <CalendarTrigger>
      <StartBoundary>${today}T${t}:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek><DaysOfWeek>${dayXml}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>`).join('');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xmlEsc(user)}</Author>
    <Description>Etsy Otonom Dijital Ürün Fabrikası - günlük ${count} ürün üretir ve Etsy'ye yükler.</Description>
  </RegistrationInfo>
  <Triggers>${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT3H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xmlEsc(vbs)}"</Arguments>
      <WorkingDirectory>${xmlEsc(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

async function winTaskInstall(opts) {
  if (process.platform !== 'win32') throw new Error('Windows Görev Zamanlayıcı yalnızca Windows\'ta kullanılabilir');
  const o = { ...DEFAULT_SCHEDULE, ...opts };
  if (!o.times.length || !o.days.length) throw new Error('En az bir saat ve bir gün seçin');
  const xmlPath = path.join(DATA, 'scripts', 'task.xml');
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  const xml = taskXml(o);
  fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
  const r = await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F']);
  if (!r.ok) throw new Error(`Görev oluşturulamadı: ${(r.err || r.out).trim()}`);
  writeConfig({ windows_task: { times: o.times, days: o.days, count: o.count } });
  return winTaskStatus();
}

async function winTaskRemove() {
  if (process.platform !== 'win32') return { installed: false };
  const r = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  if (!r.ok && !/bulunamad|cannot find|does not exist/i.test(r.err + r.out)) throw new Error(`Görev silinemedi: ${(r.err || r.out).trim()}`);
  return { installed: false };
}

async function winTaskRunNow() {
  const r = await run('schtasks', ['/Run', '/TN', TASK_NAME]);
  if (!r.ok) throw new Error(`Görev başlatılamadı: ${(r.err || r.out).trim()}`);
  return true;
}

async function winTaskStatus() {
  if (process.platform !== 'win32') return { installed: false, supported: false };
  const r = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
  if (!r.ok) return { installed: false, supported: true };
  const field = (re) => { const m = r.out.match(re); return m ? m[1].trim() : null; };
  return {
    installed: true,
    supported: true,
    next: field(/(?:Next Run Time|Sonraki Çalışma Zamanı|Sonraki Çalıştırma Zamanı)\s*:\s*(.+)/i),
    last: field(/(?:Last Run Time|Son Çalışma Zamanı|Son Çalıştırma Zamanı)\s*:\s*(.+)/i),
    lastResult: field(/(?:Last Result|Son Sonuç)\s*:\s*(.+)/i),
    status: field(/(?:^|\n)\s*(?:Status|Durum)\s*:\s*(.+)/i),
    config: readConfig().windows_task || null,
  };
}

/* ======================================================================
 * Bildirim ve tepsi
 * ==================================================================== */
function notifyDone(d) {
  if (!d || d.dryRun) return;
  const body = `${d.produced} ürün üretildi, ${d.uploaded} tanesi Etsy'ye yüklendi${d.review ? `, ${d.review} tanesi incelemeni bekliyor` : ''}${d.failed ? `, ${d.failed} başarısız` : ''}.`;
  if (Notification.isSupported()) {
    const n = new Notification({ title: d.source === 'schedule' ? '⏰ Planlı üretim tamamlandı' : 'Üretim tamamlandı', body, icon: ICON });
    n.on('click', showWindow);
    n.show();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function updateTray() {
  if (!tray) return;
  const s = getSchedule();
  const nr = nextRun(s);
  tray.setToolTip(`Etsy Otonom Fabrika — ${workerBusy.busy ? 'çalışıyor' : 'hazır'}${nr ? `\nSonraki planlı üretim: ${nr.label}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Paneli göster', click: showWindow },
    { type: 'separator' },
    { label: nr ? `Sonraki: ${nr.label}` : 'Panel zamanlayıcısı kapalı', enabled: false },
    { label: 'Şimdi 1 ürün üret', enabled: !workerBusy.busy && workerReady, click: () => callWorker('run', { count: 1, dryRun: false, publish: true }).catch(() => {}) },
    { label: 'Durdur', enabled: !!workerBusy.busy, click: () => callWorker('stop').catch(() => {}) },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { app.isQuiting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on('click', showWindow);
  updateTray();
}

/* ======================================================================
 * Pencere
 * ==================================================================== */
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#f5f5f4',
    title: 'Etsy Otonom Dijital Ürün Fabrikası',
    autoHideMenuBar: true,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    // Zamanlayıcı açıksa ya da üretim sürüyorsa pencere kapanınca tepside çalışmaya devam et
    const cfg = readConfig();
    if (!app.isQuiting && cfg.close_to_tray !== false && (getSchedule().enabled || workerBusy.busy)) {
      e.preventDefault();
      createTray();
      win.hide();
      if (!trayHintShown && Notification.isSupported()) {
        new Notification({ title: 'Etsy Otonom Fabrika arka planda çalışıyor', body: 'Zamanlayıcı açık. Paneli saat yanındaki simgeden açabilir veya oradan çıkabilirsiniz.', icon: ICON }).show();
        trayHintShown = true;
      }
    }
  });
}

/* ======================================================================
 * IPC
 * ==================================================================== */
const inRoot = (p) => p && path.resolve(p).startsWith(ROOT);
const thumbCache = new Map();

ipcMain.handle('worker:call', (_e, type, payload) => callWorker(type, payload));
ipcMain.handle('worker:status', () => ({ ready: workerReady, ...workerBusy }));
ipcMain.handle('settings:get', () => {
  const env = readEnv();
  const out = {};
  for (const k of ENV_KEYS) out[k] = env[k] || '';
  return { env: out, config: readConfig() };
});
ipcMain.handle('settings:save', (_e, { env, config }) => {
  if (env) {
    const clean = {};
    for (const k of ENV_KEYS) if (Object.prototype.hasOwnProperty.call(env, k)) clean[k] = String(env[k] || '').trim();
    writeEnv(clean);
  }
  if (config) writeConfig(config);
  updateTray();
  return true;
});
ipcMain.handle('schedule:get', () => ({ schedule: getSchedule(), next: nextRun() }));
ipcMain.handle('schedule:save', (_e, schedule) => {
  const s = { ...DEFAULT_SCHEDULE, ...schedule };
  s.times = [...new Set((s.times || []).filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
  s.days = [...new Set((s.days || []).map(Number).filter((d) => d >= 0 && d <= 6))];
  s.count = Math.max(1, Math.min(20, Number(s.count) || 1));
  writeConfig({ schedule: s });
  updateTray();
  if (s.enabled) createTray();
  return { schedule: s, next: nextRun(s) };
});
ipcMain.handle('wintask:status', () => winTaskStatus());
ipcMain.handle('wintask:install', (_e, opts) => winTaskInstall(opts));
ipcMain.handle('wintask:remove', () => winTaskRemove());
ipcMain.handle('wintask:run', () => winTaskRunNow());
ipcMain.handle('logs:activity', (_e, n = 200) => {
  try {
    const lines = fs.readFileSync(ACTIVITY_LOG, 'utf8').trim().split('\n').slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
});
ipcMain.handle('img:thumb', (_e, p, width = 320) => {
  if (!inRoot(p) || !fs.existsSync(p)) return null;
  const key = `${p}|${width}|${fs.statSync(p).mtimeMs}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const url = img.resize({ width, quality: 'good' }).toDataURL();
  if (thumbCache.size > 300) thumbCache.clear();
  thumbCache.set(key, url);
  return url;
});
ipcMain.handle('shell:openFolder', async (_e, p) => {
  if (!inRoot(p)) throw new Error('Geçersiz klasör');
  const err = await shell.openPath(path.resolve(p));
  if (err) throw new Error(err);
  return true;
});
ipcMain.handle('shell:openFile', async (_e, p) => {
  if (!inRoot(p) || !fs.existsSync(p)) throw new Error('Dosya bulunamadı');
  const err = await shell.openPath(path.resolve(p));
  if (err) throw new Error(err);
  return true;
});
const pickedImages = new Set();
const pastedHashes = new Map();
ipcMain.handle('dialog:images', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Tasarım görsellerini seçin (en fazla 5)', defaultPath: app.getPath('downloads'),
    properties: ['openFile', 'multiSelections'], filters: [{ name: 'Görseller', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (r.canceled) return [];
  const files = r.filePaths.slice(0, 5);
  files.forEach((f) => pickedImages.add(path.resolve(f)));
  return files;
});
ipcMain.handle('clipboard:image', () => {
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  const dir = path.join(ROOT, 'data', 'imports');
  fs.mkdirSync(dir, { recursive: true });
  const buf = img.toPNG();
  const hash = require('crypto').createHash('md5').update(buf).digest('hex');
  pastedHashes.set(hash, pastedHashes.get(hash) || null);
  const prev = pastedHashes.get(hash);
  if (prev && fs.existsSync(prev)) return { path: prev, duplicate: true, ...img.getSize() };
  const f = path.join(dir, `pasted_${Date.now()}.png`);
  fs.writeFileSync(f, buf);
  pastedHashes.set(hash, f);
  pickedImages.add(path.resolve(f));
  const { width, height } = img.getSize();
  return { path: f, width, height };
});
ipcMain.handle('img:thumbPicked', (_e, p, width = 240) => {
  if (!pickedImages.has(path.resolve(p)) || !fs.existsSync(p)) return null;
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img.resize({ width, quality: 'good' }).toDataURL();
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (!/^https:\/\//.test(url)) throw new Error('Geçersiz bağlantı');
  return shell.openExternal(url);
});
ipcMain.handle('app:paths', () => ({ root: ROOT, output: path.join(ROOT, 'output'), logs: path.join(ROOT, 'logs') }));

/* ======================================================================
 * Uygulama yaşam döngüsü
 * ==================================================================== */
if (process.platform === 'win32') app.setAppUserModelId('com.etsy.otonom.fabrika');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Kısayola tekrar tıklanırsa ikinci kopya açılmaz, mevcut pencere öne gelir
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    startWorker();
    createWindow();
    watchForUpdates();
    if (getSchedule().enabled) createTray();
    setInterval(() => { schedulerTick().catch(() => {}); }, 30000);
    setTimeout(() => { schedulerTick().catch(() => {}); }, 8000);
    app.on('activate', showWindow);
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    if (quitting) return;
    quitting = true;
    if (worker && worker.connected) {
      try { worker.send({ id: ++reqId, type: 'stop' }); } catch { /* yok say */ }
      setTimeout(() => { try { worker.kill(); } catch { /* yok say */ } }, 800);
    }
  });
  app.on('window-all-closed', () => {
    if (getSchedule().enabled && readConfig().close_to_tray !== false && !app.isQuiting) return; // tepside çalışmaya devam
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Beklenmeyen hata', String(err && err.stack ? err.stack : err));
});
