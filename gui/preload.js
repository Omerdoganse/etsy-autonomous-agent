'use strict';
/** Güvenli IPC katmanı: renderer yalnızca bu sınırlı API'yi görür (Node erişimi yok). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (type, payload) => ipcRenderer.invoke('worker:call', type, payload),
  status: () => ipcRenderer.invoke('worker:status'),
  onEvent: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('worker-event', handler);
    return () => ipcRenderer.removeListener('worker-event', handler);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  getSchedule: () => ipcRenderer.invoke('schedule:get'),
  saveSchedule: (s) => ipcRenderer.invoke('schedule:save', s),
  winTaskStatus: () => ipcRenderer.invoke('wintask:status'),
  winTaskInstall: (o) => ipcRenderer.invoke('wintask:install', o),
  winTaskRemove: () => ipcRenderer.invoke('wintask:remove'),
  winTaskRun: () => ipcRenderer.invoke('wintask:run'),
  activity: (n) => ipcRenderer.invoke('logs:activity', n),
  thumb: (p, w) => ipcRenderer.invoke('img:thumb', p, w),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  openFile: (p) => ipcRenderer.invoke('shell:openFile', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  paths: () => ipcRenderer.invoke('app:paths'),
  pickImages: () => ipcRenderer.invoke('dialog:images'),
  pasteImage: () => ipcRenderer.invoke('clipboard:image'),
  thumbPicked: (p, w) => ipcRenderer.invoke('img:thumbPicked', p, w),
});
