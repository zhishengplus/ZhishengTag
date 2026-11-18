'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, shell, dialog,
  powerMonitor, powerSaveBlocker, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Desk, dateKey } = require('./desk');

const TEST_MODE = !app.isPackaged && process.argv.includes('--smoke-test');
if (TEST_MODE) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.setName('ZhishengTag');
const override = process.env.ZHISHENG_TAG_DATA || process.env.PAPER_NOTES_DATA;
const DATA_DIR = path.resolve(TEST_MODE ? process.env.ZHISHENG_SMOKE_DATA || path.join(__dirname, '.smoke-data')
  : override || path.join(app.getPath('appData'), 'ZhishengTag'));
const legacyData = TEST_MODE || override ? [] : ['E:\\PaperNotes\\data', path.join(app.getPath('appData'), '纸上便签')];
const cacheDir = TEST_MODE ? DATA_DIR : path.join(DATA_DIR, 'appdata');
fs.mkdirSync(cacheDir, { recursive: true });
app.setPath('userData', cacheDir);

const COLORS = new Set(['butter', 'rose', 'sage', 'sky', 'lilac', 'linen']);
const noteWindows = new Map();
let store;
let manager = null;
let tray = null;
let quitting = false;
let readyToQuit = false;
let flushing = false;
let desk;
let captureOwner = null;
let powerLock = null;
const noteDrafts = new Map();
const decodes = new Map();

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
const text = (value, max = 100000) => typeof value === 'string' ? value.slice(0, max) : '';
const publicNote = (n) => ({ ...n, bounds: { ...n.bounds } });

// Only a small, intentional formatting vocabulary is persisted. No scripts,
// remote images, links, inline handlers or arbitrary CSS can enter a note.
const allowedTags = new Set(['div', 'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'blockquote']);
function sanitizeHtml(value) {
  // Only the editor's intentional, attribute-free formatting vocabulary survives.
  // Text encoded as &lt;...&gt; remains plain text, never becomes executable HTML.
  return text(value, 200000).replace(/<\s*(\/?)\s*([a-zA-Z0-9]+)(?:\s[^<>]*)?>/g, (_match, closing, tag) => {
    tag = tag.toLowerCase();
    if (!allowedTags.has(tag)) return '';
    if (tag === 'br') return '<br>';
    return `<${closing ? '/' : ''}${tag}>`;
  });
}

class NoteStore {
  constructor() {
    this.file = path.join(DATA_DIR, 'notes.json');
    this.backup = path.join(DATA_DIR, 'notes.backup.json');
    this.notes = [];
    this.load();
  }

  load() {
    const candidates = [this.file, this.backup,
      ...legacyData.flatMap(dir => ['notes.json', 'notes.backup.json'].map(name => path.join(dir, name)))];
    for (const file of candidates) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.version === 1 && Array.isArray(data.notes)) {
          this.notes = data.notes.map(n => this.normalize(n)).filter(Boolean);
          if (file !== this.file && file !== this.backup) this.persist();
          return;
        }
      } catch (_) { /* Try the last known good copy. */ }
    }
    const now = new Date().toISOString();
    this.notes = [{
      id: uid(), title: '工位使用指南',
      html: '<div><b>记录</b>　打开工作台，开始分段录音。</div><div><b>整理</b>　接入自己的模型，自动提取摘要和待办。</div><div><b>行动</b>　在计划里查看今天与明天。</div><div><br></div><div>Ctrl + N 新建便签，拖动顶部调整桌面位置。</div>',
      color: 'butter', fontSize: 16, pinned: false, hidden: !TEST_MODE,
      createdAt: now, updatedAt: now, deletedAt: null,
      bounds: this.freshBounds(0)
    }];
    this.persist();
  }

  normalize(n) {
    if (!n || typeof n.id !== 'string' || !/^[a-z0-9-]{5,50}$/i.test(n.id)) return null;
    const now = new Date().toISOString();
    return {
      id: n.id, title: text(n.title, 160), html: sanitizeHtml(n.html),
      color: COLORS.has(n.color) ? n.color : 'butter',
      fontSize: Math.max(13, Math.min(24, Number(n.fontSize) || 16)),
      pinned: !!n.pinned, hidden: !!n.hidden,
      createdAt: text(n.createdAt, 40) || now, updatedAt: text(n.updatedAt, 40) || now,
      deletedAt: n.deletedAt ? text(n.deletedAt, 40) : null,
      bounds: safeBounds(n.bounds)
    };
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, notes: this.notes }, null, 2), 'utf8');
    if (fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, this.backup); } catch (_) { /* Temp file is still intact. */ }
    }
    fs.renameSync(temp, this.file);
  }

  freshBounds(offset = 0) {
    const area = screen.getPrimaryDisplay().workArea;
    const width = 344, height = 440;
    return { x: area.x + area.width - width - 32 - (offset % 4) * 24,
      y: area.y + 28 + (offset % 6) * 26, width, height };
  }

  create(sourceId, content = {}) {
    const now = new Date().toISOString();
    const source = this.notes.find(n => n.id === sourceId && !n.deletedAt);
    const base = source ? source.bounds : this.freshBounds(this.notes.length);
    const area = screen.getDisplayMatching(base).workArea;
    const bounds = safeBounds({ ...base, x: base.x + 28, y: base.y + 28 });
    if (bounds.x === base.x && bounds.y === base.y) {
      bounds.x = area.x + 36 + (this.notes.length % 6) * 24;
      bounds.y = area.y + 36 + (this.notes.length % 5) * 26;
    }
    const note = { id: uid(), title: text(content.title, 160), html: sanitizeHtml(content.html), color: source ? source.color : 'butter',
      fontSize: source ? source.fontSize : 16, pinned: false, hidden: false,
      createdAt: now, updatedAt: now, deletedAt: null, bounds };
    this.notes.push(note);
    try { this.persist(); } catch (error) { this.notes.pop(); throw error; }
    createNoteWindow(note, true, content.organize === true);
    broadcast('create', note);
    return publicNote(note);
  }

  update(id, patch) {
    const index = this.notes.findIndex(n => n.id === id && !n.deletedAt);
    const previous = this.notes[index];
    const note = previous && { ...previous };
    if (!note) throw new Error('便签不存在');
    if (typeof patch.title === 'string') note.title = patch.title.slice(0, 160);
    if (typeof patch.html === 'string') note.html = sanitizeHtml(patch.html);
    if (COLORS.has(patch.color)) note.color = patch.color;
    if (patch.fontSize !== undefined) note.fontSize = Math.max(13, Math.min(24, Number(patch.fontSize) || 16));
    if (patch.pinned !== undefined) note.pinned = !!patch.pinned;
    if (patch.hidden !== undefined) note.hidden = !!patch.hidden;
    if (patch.bounds) note.bounds = safeBounds(patch.bounds);
    if (patch.content) note.updatedAt = new Date().toISOString();
    this.notes[index] = note;
    try { this.persist(); } catch (error) { this.notes[index] = previous; throw error; }
    syncNoteWindow(note);
    broadcast('update', note);
    return publicNote(note);
  }

  remove(id) {
    const note = this.notes.find(n => n.id === id && !n.deletedAt);
    if (!note) return;
    note.deletedAt = new Date().toISOString();
    note.hidden = true;
    note.pinned = false;
    this.persist();
    syncNoteWindow(note);
    if (desk?.captureState()?.kind === 'voice' && desk.owns(noteWindows.get(id)?.webContents)) requestCapture('stop-silent');
    noteWindows.get(id)?.hide();
    broadcast('remove', note);
    updateTray();
  }

  restore(id) {
    const note = this.notes.find(n => n.id === id);
    if (!note) return;
    note.deletedAt = null;
    note.hidden = false;
    this.persist();
    openNote(id);
    broadcast('restore', note);
  }
}

function safeBounds(input = {}) {
  const width = Math.round(Math.max(280, Math.min(1200, Number(input.width) || 344)));
  const height = Math.round(Math.max(320, Math.min(1200, Number(input.height) || 440)));
  const proposed = { x: Number(input.x) || 0, y: Number(input.y) || 0, width, height };
  const area = screen.getDisplayMatching(proposed).workArea;
  return { width, height,
    x: Math.round(Math.max(area.x - width + 100, Math.min(area.x + area.width - 100, proposed.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - 80, proposed.y))) };
}

function broadcast(reason, note) {
  const payload = { reason, note: publicNote(note) };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('notes:changed', payload);
  }
  updateTray();
}

function syncNoteWindow(note) {
  const win = noteWindows.get(note.id);
  if (!win || win.isDestroyed() || win.isAlwaysOnTop() === note.pinned) return;
  win.setAlwaysOnTop(note.pinned, 'floating');
  // The Windows taskbar can be in the normal z-order band. Electron's floating
  // level then puts the note behind it and strips the topmost flag.
  if (process.platform === 'win32' && note.pinned && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'pop-up-menu');
}

function createNoteWindow(note, focus = false, organize = false) {
  if (note.deletedAt) return null;
  const existing = noteWindows.get(note.id);
  if (existing && !existing.isDestroyed()) {
    if (!note.hidden) { existing.show(); if (focus) existing.focus(); }
    return existing;
  }
  const win = new BrowserWindow({
    width: note.bounds.width, height: note.bounds.height,
    x: note.bounds.x, y: note.bounds.y,
    minWidth: 280, minHeight: 320, maxWidth: 1200, maxHeight: 1200,
    frame: false, transparent: true, hasShadow: false,
    resizable: true, maximizable: false, minimizable: false,
    fullscreenable: false, skipTaskbar: true, show: false,
    backgroundColor: '#00000000', alwaysOnTop: note.pinned,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, spellcheck: true
    }
  });
  noteWindows.set(note.id, win);
  syncNoteWindow(note);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'note.html'), { query: { id: note.id, ...(organize ? { organize: '1' } : {}) } });
  win.once('ready-to-show', () => {
    if (!note.hidden && !quitting) { win.show(); if (focus) win.focus(); }
  });
  let boundsTimer;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (quitting || win.isDestroyed() || win.isMinimized()) return;
      const current = store.notes.find(n => n.id === note.id);
      if (current) { current.bounds = safeBounds(win.getBounds()); store.persist(); }
    }, 250);
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);
  win.on('focus', () => win.webContents.send('window:focus', true));
  win.on('blur', () => win.webContents.send('window:focus', false));
  win.on('close', event => {
    if (!readyToQuit) {
      event.preventDefault();
      const current = store.notes.find(n => n.id === note.id);
      if (current) { current.hidden = true; store.persist(); }
      if (desk?.owns(win.webContents)) requestCapture('stop-silent');
      win.hide();
      broadcast('hide', current || note);
    }
  });
  win.on('closed', () => noteWindows.delete(note.id));
  watchCaptureWindow(win);
  return win;
}

function openNote(id, focus = true) {
  const note = store.notes.find(n => n.id === id && !n.deletedAt);
  if (!note) return false;
  note.hidden = false;
  store.persist();
  const win = createNoteWindow(note, focus);
  if (win) { win.show(); if (focus) win.focus(); }
  broadcast('show', note);
  return true;
}

function createManager() {
  if (manager && !manager.isDestroyed()) return manager;
  const workArea = screen.getPrimaryDisplay().workArea;
  manager = new BrowserWindow({
    width: Math.min(1320, workArea.width - 24), height: Math.min(870, workArea.height - 24),
    minWidth: 760, minHeight: 560, center: true,
    show: false, frame: false, backgroundColor: '#eef0ee',
    title: '枳生Ai桌签 · ZhishengTag', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true
    }
  });
  manager.loadFile(path.join(__dirname, 'manager.html'));
  manager.once('ready-to-show', () => { if (!quitting) manager.show(); });
  manager.on('close', event => {
    if (!readyToQuit) { event.preventDefault(); manager.hide(); }
  });
  manager.on('closed', () => { manager = null; });
  watchCaptureWindow(manager);
  return manager;
}

function showManager() {
  const win = createManager();
  win.show(); win.focus();
}

function showAll() {
  for (const note of store.notes.filter(n => !n.deletedAt)) {
    note.hidden = false;
    createNoteWindow(note, false);
  }
  store.persist();
  broadcast('show-all', { ...store.notes[0], id: 'all' });
}

function noteIdFor(owner) {
  for (const [id, win] of noteWindows) if (!win.isDestroyed() && win.webContents === owner) return id;
  return null;
}

function requestCapture(action, reason = '') {
  if (captureOwner && !captureOwner.isDestroyed()) captureOwner.send('desk:capture-command', { action, reason });
}

function updateCapture(state, owner) {
  if (captureOwner && captureOwner !== owner && !captureOwner.isDestroyed()) captureOwner.backgroundThrottling = true;
  captureOwner = owner;
  if (owner && !owner.isDestroyed()) owner.backgroundThrottling = state.phase === 'paused';
  if (state?.phase === 'recording' && powerLock === null) powerLock = powerSaveBlocker.start('prevent-app-suspension');
  if (state?.phase !== 'recording' && powerLock !== null) {
    powerSaveBlocker.stop(powerLock);
    powerLock = null;
  }
  updateTray();
}

function watchCaptureWindow(win) {
  const owner = win.webContents;
  const ownerId = owner.id;
  const lost = () => {
    noteDrafts.delete(ownerId);
    if (desk?.owns(owner)) {
      try { desk.end(owner, desk.captureState().sessionId, true); } catch (error) { console.error(error.message); }
    }
  };
  owner.on('render-process-gone', lost);
  owner.on('destroyed', lost);
  owner.setWindowOpenHandler(() => ({ action: 'deny' }));
  owner.on('will-navigate', event => event.preventDefault());
}

function requestWave(bytes) {
  const win = createManager();
  return new Promise((resolve, reject) => {
    const id = uid();
    const timer = setTimeout(() => {
      decodes.delete(id);
      reject(new Error('本地音频解码超时，请重新整理'));
    }, 30000);
    decodes.set(id, { resolve, reject, timer });
    win.webContents.send('desk:decode', { id, bytes });
  });
}

function deskEvent(type, data) {
  if (manager && !manager.isDestroyed()) manager.webContents.send('desk:' + type, data);
  if (type === 'clip' || type === 'preview') {
    const id = desk.session(data.sid).noteId;
    const win = id && noteWindows.get(id);
    if (win && !win.isDestroyed()) win.webContents.send('desk:' + type, data);
  }
}

const escapeHtml = value => String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[character]));
const paragraphs = value => String(value).split('\n').map(line => '<div>' + escapeHtml(line) + '</div>').join('');

function reportHtml(report) {
  const list = items => '<ul>' + items.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
  return '<div><b>摘要</b></div>' + paragraphs(report.summary) +
    (report.highlights.length ? '<div><b>重点</b></div>' + list(report.highlights) : '') +
    (report.tasks.length ? '<div><b>待办</b></div>' + list(report.tasks.map(task => [
      task.title, task.date, task.time, task.horizon === 'long' ? '长期' : '短期'
    ].filter(Boolean).join('  '))) : '');
}

function wireDesk() {
  const fromManager = owner => manager && !manager.isDestroyed() && manager.webContents === owner;
  const handle = (name, handler, managerOnly = true) => ipcMain.handle('desk:' + name, (event, ...values) => {
    const owner = event.sender;
    if (event.senderFrame !== owner.mainFrame || (!fromManager(owner) && (managerOnly || !noteIdFor(owner)))) {
      throw new Error('此窗口无权执行该操作');
    }
    return handler(owner, ...values);
  });
  const ownNote = owner => {
    const note = store.notes.find(item => item.id === noteIdFor(owner) && !item.deletedAt);
    if (!note) throw new Error('便签已关闭或移到回收站');
    return note;
  };
  const storeDraft = (owner, note, data) => {
    const draft = { ...data, token: uid(), noteId: note.id, titleBefore: note.title, htmlBefore: note.html };
    if (!owner.isDestroyed()) noteDrafts.set(owner.id, draft);
    return { token: draft.token, report: draft.report, transcript: draft.transcript };
  };
  handle('state', () => ({ settings: desk.publicSettings(), sessions: desk.sessions(), capture: desk.captureState(),
    tasks: desk.tasks(), routes: desk.notices(), draft: desk.draft() }));
  handle('save-draft', (_owner, body) => desk.saveDraft(body));
  handle('save-connection', (_owner, id, input) => desk.saveConnection(id, input || {}));
  handle('save-routes', (_owner, input) => desk.saveRoutes(input || {}));
  handle('save-recording', (_owner, input) => desk.saveRecording(input || {}));
  handle('models', (_owner, id) => desk.models(id));
  handle('begin', (owner, kind) => {
    if (kind === 'desk' && fromManager(owner)) return desk.begin(owner, kind);
    if (kind === 'voice' && noteIdFor(owner)) return desk.begin(owner, kind, ownNote(owner).id);
    throw new Error('录音来源无效');
  }, false);
  handle('phase', (owner, id, phase) => desk.phase(owner, id, phase), false);
  handle('put', (owner, id, clip) => desk.put(owner, id, clip), false);
  handle('end', (owner, id) => desk.end(owner, id), false);
  handle('clips', (_owner, sid, offset) => desk.clips(sid, offset));
  handle('audio', (_owner, sid, id) => desk.audio(sid, id));
  handle('process', (_owner, sid, id) => desk.process(sid, id));
  handle('clip-note', (_owner, sid, id) => {
    const clip = desk.clip(sid, id);
    if (!clip.report && !clip.transcript) throw new Error('请先转写录音');
    return store.create(undefined, { title: clip.report?.title || '录音转写', html: clip.report ? reportHtml(clip.report) : paragraphs(clip.transcript) });
  });
  handle('quick-note', (_owner, body, organize) => {
    const material = text(body, 12000).trim();
    if (!material) throw new Error('先输入便签内容');
    if (organize === true) desk.route('write', true);
    return store.create(undefined, {
      title: material.split('\n')[0].slice(0, 32), html: paragraphs(material), organize: organize === true
    });
  });
  handle('task', (_owner, id, input) => desk.saveTask(id, input || {}));
  handle('day', (_owner, date) => ({ tasks: desk.dayTasks(date), plan: desk.getPlan(date) }));
  handle('plan', (owner, date) => desk.generatePlan(date, summary => owner.send('desk:plan-preview', { date, summary })));
  handle('note-title', async (_owner, id, body, expected) => {
    const note = store.notes.find(item => item.id === id && !item.deletedAt);
    if (!note || note.html !== expected) throw new Error('便签已改动，请刷新后重试');
    const title = await desk.title(note.title, body);
    const current = store.notes.find(item => item.id === id);
    if (current?.deletedAt || current?.title !== note.title || current?.html !== note.html) throw new Error('便签已改动，请重新生成标题');
    return store.update(id, { title, content: true });
  });
  handle('organize-note', async (owner, body, requestId) => {
    const note = ownNote(owner);
    const report = await desk.noteReport(note.title, body, summary => {
      if (!owner.isDestroyed()) owner.send('desk:note-preview', { requestId, summary });
    });
    return storeDraft(owner, note, { report, append: false });
  }, false);
  handle('voice-note', async (owner, sid, id) => {
    const note = ownNote(owner);
    if (desk.session(sid).noteId !== note.id) throw new Error('录音不属于这张便签');
    const clip = await desk.process(sid, id);
    if (!clip.transcript) throw new Error(clip.error || '没有识别到可转写的语音');
    return storeDraft(owner, note, { report: clip.report, transcript: clip.transcript, append: true });
  }, false);
  handle('apply-note', (owner, token, choice) => {
    const note = ownNote(owner);
    const draft = noteDrafts.get(owner.id);
    if (!draft || draft.token !== token || draft.noteId !== note.id) throw new Error('请重新生成整理预览');
    if (note.html !== draft.htmlBefore || note.title !== draft.titleBefore) throw new Error('便签已改动，请重新整理后应用');
    const raw = choice === 'transcript';
    if ((raw && !draft.transcript) || (!raw && !draft.report)) throw new Error('该预览没有可应用的内容');
    const body = raw ? paragraphs(draft.transcript) : reportHtml(draft.report);
    const title = draft.append && note.title ? note.title : draft.report?.title || note.title;
    if (!raw && !draft.append) desk.addTasks(draft.report.tasks, { kind: 'note', id: note.id, label: title });
    const saved = store.update(note.id, { title, html: (draft.append ? note.html + '<div><br></div>' : '') + body, content: true });
    noteDrafts.delete(owner.id);
    return saved;
  }, false);
  handle('settings-page', () => {
    showManager();
    const showSettings = () => manager?.webContents.send('desk:show-settings');
    if (manager.webContents.isLoadingMainFrame()) manager.webContents.once('did-finish-load', showSettings);
    else showSettings();
  }, false);
  ipcMain.on('desk:decoded', (event, id, data) => {
    if (!fromManager(event.sender) || event.senderFrame !== event.sender.mainFrame) return;
    const pending = decodes.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    decodes.delete(id);
    if (!Array.isArray(data) || !data.length || data.length > 6 ||
        data.some(item => !(item instanceof Uint8Array) || item.length > 4_000_000)) {
      pending.reject(new Error('本地音频无法转换为 WAV，请尝试另一段录音'));
      return;
    }
    pending.resolve(data.map(bytes => ({ bytes: Buffer.from(bytes), type: 'audio/wav', extension: 'wav' })));
  });
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const count = store.notes.filter(n => !n.deletedAt && !n.hidden).length;
  const capture = desk?.captureState();
  const label = capture?.phase === 'paused' ? '录音已暂停' : capture ? '麦克风正在使用' : count + ' 张便签在桌面';
  tray.setToolTip('枳生Ai桌签 · ' + label);
  const iconName = capture?.phase === 'recording' ? 'tray-recording.png' : 'tray.png';
  tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', iconName)));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: showManager },
    { label: '新建便签', click: () => store.create() },
    { label: '展开全部便签', click: showAll },
    ...(capture ? [{ label: '结束当前录音', click: () => requestCapture('stop') }] : []),
    { type: 'separator' },
    { label: '退出 ZhishengTag', click: flushAndQuit }
  ]));
}

async function flushAndQuit() {
  if (flushing) return;
  flushing = true;
  quitting = true;
  const pending = new Map();
  const done = (event, requestId, ok = true) => {
    const request = pending.get(requestId);
    if (request?.owner === event.sender) request.finish(ok);
  };
  ipcMain.on('app:flush-done', done);
  const waits = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isLoading()) {
      waits.push(new Promise(resolve => {
        const requestId = uid();
        const owner = win.webContents;
        const timer = setTimeout(() => finish(owner !== captureOwner), owner === captureOwner ? 6500 : 1200);
        const finish = ok => { clearTimeout(timer); pending.delete(requestId); resolve(ok); };
        pending.set(requestId, { owner, finish });
        win.webContents.send('app:flush', requestId);
      }));
    }
  }
  const results = await Promise.all(waits);
  ipcMain.removeListener('app:flush-done', done);
  if (results.includes(false) || desk?.captureState()) {
    quitting = false;
    flushing = false;
    showManager();
    if (manager) void dialog.showMessageBox(manager, {
      type: 'warning', message: '还有内容等待保存', detail: '请检查数据盘或录音状态，存盘完成后再退出。', buttons: ['返回应用']
    });
    return;
  }
  desk?.close();
  try { store.persist(); } catch (_) { /* Atomic temp copy is retained. */ }
  readyToQuit = true;
  app.quit();
}

function wireIpc() {
  ipcMain.handle('note:get', (event, id) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const ownId = win ? [...noteWindows.entries()].find(([, w]) => w === win)?.[0] : null;
    if (id !== ownId) throw new Error('无权读取其他窗口的便签');
    const note = store.notes.find(n => n.id === id && !n.deletedAt);
    if (!note) throw new Error('便签不存在');
    return publicNote(note);
  });
  ipcMain.handle('notes:list', () => store.notes.map(publicNote));
  ipcMain.handle('note:update', (event, id, patch) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== manager && ![...noteWindows.values()].includes(win)) throw new Error('未知窗口');
    const ownId = [...noteWindows.entries()].find(([, w]) => w === win)?.[0];
    if (win !== manager && id !== ownId) throw new Error('只能编辑当前便签');
    return store.update(id, patch || {});
  });
  ipcMain.handle('note:create', (_event, sourceId) => store.create(sourceId));
  ipcMain.handle('note:open', (_event, id) => openNote(id));
  ipcMain.handle('note:remove', (_event, id) => store.remove(id));
  ipcMain.handle('note:restore', (_event, id) => store.restore(id));
  ipcMain.handle('notes:show-all', showAll);
  ipcMain.handle('manager:show', showManager);
  ipcMain.handle('note:hide', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && [...noteWindows.values()].includes(win)) win.close();
  });
  ipcMain.handle('manager:window', (_event, action) => {
    if (!manager) return;
    if (action === 'minimize') manager.minimize();
    if (action === 'maximize') manager.isMaximized() ? manager.unmaximize() : manager.maximize();
    if (action === 'close') manager.hide();
  });
  ipcMain.handle('data:folder', () => shell.openPath(path.dirname(store.file)));
  ipcMain.handle('data:export', async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) return { canceled: true };
    const result = await dialog.showSaveDialog(owner, {
      title: '备份全部便签', defaultPath: 'ZhishengTag-便签-' + dateKey() + '.json',
      filters: [{ name: '便签备份（含格式与回收站）', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const temp = `${result.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes: store.notes }, null, 2), 'utf8');
    fs.renameSync(temp, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(image);
  tray.on('click', showManager);
  updateTray();
}

app.setAppUserModelId('com.zhishengtag.desktop');
const singleInstance = TEST_MODE ? true : app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => showManager());
  app.on('window-all-closed', event => event.preventDefault());
  app.on('before-quit', event => {
    if (!readyToQuit) { event.preventDefault(); quitting = true; flushAndQuit(); }
  });
  app.whenReady().then(() => {
    if (TEST_MODE && !process.argv.includes('--restart')) {
      // A new test run starts clean; the intentional restart keeps its data.
      for (const name of ['notes.json', 'notes.backup.json']) fs.rmSync(path.join(app.getPath('userData'), name), { force: true });
    }
    store = new NoteStore();
    desk = new Desk(DATA_DIR, safeStorage, { send: deskEvent, onCapture: updateCapture, decodeWave: requestWave });
    wireIpc();
    wireDesk();
    session.defaultSession.setPermissionCheckHandler((owner, permission, _origin, details) =>
      permission === 'media' && desk.owns(owner) && ['audio', 'unknown', undefined].includes(details.mediaType));
    session.defaultSession.setPermissionRequestHandler((owner, permission, decide, details) =>
      decide(permission === 'media' && desk.owns(owner) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio'));
    powerMonitor.on('suspend', () => requestCapture('pause', '系统即将休眠，录音已暂停'));
    createTray();
    for (const note of store.notes.filter(n => !n.deletedAt && !n.hidden)) createNoteWindow(note);
    if (TEST_MODE) setTimeout(() => require('./smoke-test.js')({ app, store, desk, manager: showManager, noteWindows, flushAndQuit }), 1200);
    else showManager();
  }).catch(error => {
    dialog.showErrorBox('ZhishengTag 无法启动', error.stack || String(error));
    app.exit(1);
  });
}
