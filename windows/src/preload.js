'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('flits', {
  state: () => ipcRenderer.invoke('state'),
  pick: (peerId, folder) => ipcRenderer.invoke('send:pick', peerId, !!folder),
  sendDropped: (peerId, files) => ipcRenderer.invoke('send:paths', peerId, Array.from(files).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  sendText: (peerId, text) => ipcRenderer.invoke('send:text', peerId, text),
  respond: (id, accept, remember) => ipcRenderer.invoke('offer:respond', id, accept, remember),
  cancel: (id) => ipcRenderer.invoke('transfer:cancel', id),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  showPath: (p) => ipcRenderer.invoke('show:path', p),
  openSaveDir: () => ipcRenderer.invoke('open:saveDir'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  addPeer: (host) => ipcRenderer.invoke('peer:add', host),
  pickDir: () => ipcRenderer.invoke('settings:pickDir'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  updatePage: () => ipcRenderer.invoke('update:page'),
  downloads: () => ipcRenderer.invoke('dl:list'),
  download: (url, connections) => ipcRenderer.invoke('dl:add', url, connections),
  cancelDownload: (id) => ipcRenderer.invoke('dl:cancel', id),
  pauseDownload: (id) => ipcRenderer.invoke('dl:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('dl:resume', id),
  clearDownloads: () => ipcRenderer.invoke('dl:clear'),
  onDownload: on('download'),
  onUpdate: on('update'),
  onPeers: on('peers'),
  onTransfer: on('transfer'),
  onOffer: on('offer'),
  onOfferClosed: on('offer-closed'),
});
