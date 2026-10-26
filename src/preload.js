// Bridge for the app's own pages (launcher log, API key, update). The dsh interface never gets this preload.
const { contextBridge, ipcRenderer } = require('electron');

const invokes = new Set(['apikey:save']);
const sends = new Set(['apikey:skip', 'open:keys-page', 'update:cancel']);
const events = new Set(['launcher:status', 'launcher:log', 'update:progress']);

contextBridge.exposeInMainWorld('dsh', {
  invoke: (channel, ...args) => invokes.has(channel)
    ? ipcRenderer.invoke(channel, ...args) : Promise.reject(new Error('Unknown channel')),
  send: (channel, ...args) => { if (sends.has(channel)) ipcRenderer.send(channel, ...args); },
  on: (channel, fn) => { if (events.has(channel)) ipcRenderer.on(channel, (_e, ...args) => fn(...args)); },
});
