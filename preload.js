'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('paper', {
  get: id => ipcRenderer.invoke('note:get', id),
  list: () => ipcRenderer.invoke('notes:list'),
  update: (id, patch) => ipcRenderer.invoke('note:update', id, patch),
  create: sourceId => ipcRenderer.invoke('note:create', sourceId),
  open: id => ipcRenderer.invoke('note:open', id),
  remove: id => ipcRenderer.invoke('note:remove', id),
  hide: () => ipcRenderer.invoke('note:hide'),
  restore: id => ipcRenderer.invoke('note:restore', id),
  showAll: () => ipcRenderer.invoke('notes:show-all'),
  showManager: () => ipcRenderer.invoke('manager:show'),
  managerWindow: action => ipcRenderer.invoke('manager:window', action),
  openDataFolder: () => ipcRenderer.invoke('data:folder'),
  exportNotes: () => ipcRenderer.invoke('data:export'),
  onChanged: callback => on('notes:changed', callback),
  onFocus: callback => on('window:focus', callback),
  onFlush: callback => on('app:flush', callback),
  flushDone: (requestId, ok) => ipcRenderer.send('app:flush-done', requestId, ok)
});

const deskCall = name => (...args) => ipcRenderer.invoke('desk:' + name, ...args);
contextBridge.exposeInMainWorld('desk', {
  state: deskCall('state'),
  saveDraft: deskCall('save-draft'),
  saveConnection: deskCall('save-connection'),
  saveRoutes: deskCall('save-routes'),
  saveRecording: deskCall('save-recording'),
  models: deskCall('models'),
  begin: deskCall('begin'),
  phase: deskCall('phase'),
  put: deskCall('put'),
  end: deskCall('end'),
  clips: deskCall('clips'),
  audio: deskCall('audio'),
  process: deskCall('process'),
  clipNote: deskCall('clip-note'),
  quickNote: deskCall('quick-note'),
  task: deskCall('task'),
  day: deskCall('day'),
  plan: deskCall('plan'),
  noteTitle: deskCall('note-title'),
  organizeNote: deskCall('organize-note'),
  voiceNote: deskCall('voice-note'),
  applyNote: deskCall('apply-note'),
  settingsPage: deskCall('settings-page'),
  decoded: (id, value) => ipcRenderer.send('desk:decoded', id, value),
  onSettings: callback => on('desk:settings', callback),
  onShowSettings: callback => on('desk:show-settings', callback),
  onSessions: callback => on('desk:sessions', callback),
  onCapture: callback => on('desk:capture', callback),
  onCaptureCommand: callback => on('desk:capture-command', callback),
  onDecode: callback => on('desk:decode', callback),
  onClip: callback => on('desk:clip', callback),
  onPreview: callback => on('desk:preview', callback),
  onNotePreview: callback => on('desk:note-preview', callback),
  onPlanPreview: callback => on('desk:plan-preview', callback),
  onTasks: callback => on('desk:tasks', callback)
});
