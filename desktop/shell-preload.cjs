// CommonJS on purpose: a sandboxed preload (sandbox: true) cannot be an ES
// module, and this file must be listed in electron-builder.yml `files:` or it
// simply will not exist inside app.asar.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deskShell', {
  minimize: () => ipcRenderer.send('shell:minimize'),
  toggleMaximize: () => ipcRenderer.send('shell:toggle-maximize'),
  close: () => ipcRenderer.send('shell:close'),
});

// Machine switching lives in the main window, which uses THIS preload (not
// preload.mjs). Without it window.desk is undefined and every machine button
// silently does nothing.
contextBridge.exposeInMainWorld('desk', {
  listMachines: () => ipcRenderer.invoke('desk:list-machines'),
  machinesAttention: () => ipcRenderer.invoke('desk:machines-attention'),
  switchHub: (url, message) => ipcRenderer.invoke('desk:switch-hub', url, message),
  useLocal: (message) => ipcRenderer.invoke('desk:use-local', message),
  takePendingMessage: () => ipcRenderer.invoke('desk:take-pending-message'),
  addMachine: (machine) => ipcRenderer.invoke('desk:add-machine', machine),
  renameMachine: (url, name) => ipcRenderer.invoke('desk:rename-machine', { url, name }),
  removeMachine: (url) => ipcRenderer.invoke('desk:remove-machine', url),
  syncModel: () => ipcRenderer.invoke('desk:sync-model'),
  syncVoice: (voice) => ipcRenderer.invoke('desk:sync-voice', voice),
  syncConfig: (req) => ipcRenderer.invoke('desk:sync-config', req),
  voiceStart: () => ipcRenderer.invoke('desk:voice-start'),
  localProvision: (req) => ipcRenderer.invoke('desk:local-provision', req),
  voiceStop: () => ipcRenderer.invoke('desk:voice-stop'),
  voiceCancel: () => ipcRenderer.invoke('desk:voice-cancel'),
});
