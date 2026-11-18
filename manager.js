'use strict';

const $ = id => document.getElementById(id);
const node = (tag, className = '', value = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
};
const statusNames = { saved: '已存档', quiet: '安静片段', queued: '等待处理', directing: '制定转录策略',
  transcribing: '正在转写', organizing: '正在整理', done: '已整理', transcribed: '已转写', failed: '待重试' };
const statusText = { idle: '待机', opening: '正在开启麦克风', recording: '录音中', paused: '已暂停' };
const doing = new Set(['queued', 'directing', 'transcribing', 'organizing']);
const localClock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const calendarDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
const clips = new Map();
const entries = new Map();
const plansRunning = new Map();
const discovered = new Map();
const noteTitlesInFlight = new Set();
let settings;
let sessions = [];
let tasks = [];
let capture;
let page = 'workbench';
let tab = 'all';
let notes = [];
let clipCount = 0;
let selectedSession = '';
let clipRequest = 0;
let noteRequest = 0;
let taskRequest = 0;
let toastTimer;
let meterPosition = -1;
let lastCaptureText = '';
let dailyScope = 'today';
let planScope = 'today';
let serviceId = 'openai';
let editedTask = null;
let draftTimer;
let postingDraft = false;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', 'assets/icons.svg#' + name);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function makeButton(label, symbol, kind = 'key key-plain') {
  const control = node('button', kind);
  control.type = 'button';
  if (symbol) control.append(icon(symbol));
  if (kind.includes('icon-button')) {
    control.title = label;
    control.setAttribute('aria-label', label);
  } else control.append(label);
  return control;
}

function message(error) {
  return String(error?.message || error).replace(/^Error invoking remote method .*?: Error:\s*/, '');
}

function toast(value) {
  clearTimeout(toastTimer);
  $('toast').textContent = value;
  $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3300);
}

function run(operation, button) {
  if (button) button.disabled = true;
  return Promise.resolve().then(operation).catch(error => toast(message(error))).finally(() => {
    if (button && button.isConnected) button.disabled = false;
  });
}

function emptyBlock(title, detail, symbol) {
  const outer = node('div', symbol ? 'empty timeline-empty' : 'empty');
  if (symbol) {
    const glyph = node('span', 'empty-glyph');
    glyph.append(icon(symbol));
    outer.append(glyph);
  }
  const copy = node('div');
  copy.append(node('strong', '', title));
  if (detail) copy.append(node('p', '', detail));
  outer.append(copy);
  return outer;
}

function dateKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function updateDate() {
  const now = new Date();
  const today = dateKey();
  const plate = $('wall-date').parentElement;
  if (plate.dateTime === today) return;
  $('wall-date').textContent = today.slice(5).replace('-', '.');
  $('wall-weekday').textContent = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(now);
  plate.dateTime = today;
  if (settings) run(renderPlans);
}

function showSettingsTab(section, focus = false) {
  for (const tab of document.querySelectorAll('.settings-tabs [role=tab]')) {
    const selected = tab.id === 'tab-' + section;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus({ preventScroll: true });
  }
}

function showPage(next, settingsTab) {
  if (!['workbench', 'notes', 'plans', 'settings'].includes(next)) return;
  page = next;
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== page; });
  document.querySelectorAll('.primary-nav button, .settings-link').forEach(button => {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelector('.workspace').scrollTop = 0;
  if (next === 'notes') renderNotes();
  if (next === 'plans' || next === 'workbench') run(renderPlans);
  if (next === 'settings') {
    if (settings) renderSettings();
    if (settingsTab) showSettingsTab(settingsTab, true);
  }
}

function showModelSetup() {
  const savedModel = Object.values(settings?.connections || {}).some(item => item.configured && item.model);
  showPage('settings', savedModel ? 'routing' : 'services');
}

function renderClock(duration) {
  const seconds = Math.floor(duration / 1000);
  const label = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(part => String(part).padStart(2, '0')).join(':');
  if ($('capture-time').textContent !== label) $('capture-time').textContent = label;
}

function renderLevel(db, duration) {
  if (document.hidden || page !== 'workbench') return;
  renderClock(duration);
  const next = Math.round((db + 72) / 3);
  if (next === meterPosition) return;
  meterPosition = next;
  $('meter').setAttribute('aria-valuenow', String(Math.round(db)));
  [...$('meter').children].forEach((cell, index) => cell.classList.toggle('lit', index < next));
}

function configureCapture() {
  const external = capture && capture.kind !== 'desk';
  const phase = external ? 'idle' : recorder.phase;
  const working = phase === 'recording';
  const paused = phase === 'paused';
  $('recorder').dataset.state = phase;
  $('capture-state').textContent = external ? '便签听写中' : phase === 'idle' && recorder.duration > 0 ? '已结束' : statusText[phase];
  $('record').disabled = !!external || phase === 'opening';
  $('record-label').textContent = working ? '暂停录音' : paused ? '继续录音' : '开始录音';
  $('cut').disabled = !working;
  $('stop').disabled = !(working || paused);
  $('interval').disabled = !!recorder.session;
  $('nav-record').hidden = !capture;
  $('nav-record').dataset.paused = String(capture?.phase === 'paused');
  $('nav-record').title = capture?.phase === 'paused' ? '录音已暂停' : '麦克风使用中';
  const routes = settings?.routes || {};
  const speech = settings?.connections[routes.speech]?.configured && settings.connections[routes.speech]?.speechModel;
  const write = settings?.connections[routes.write]?.configured && settings.connections[routes.write]?.model;
  const auto = settings?.recording.auto && speech;
  $('capture-info').textContent = external ? '结束便签听写后即可开启工位录音。'
    : recorder.unsaved.length ? '存盘失败。检查磁盘后，点继续或结束重试保存。'
    : lastCaptureText || (auto ? (write ? '每段保存后整理' : '每段保存后转写') : '录音保存在本机');
  renderClock(recorder.duration);
}

const recorder = new DeskRecorder('desk', {
  onState: configureCapture,
  onLevel: renderLevel,
  onClip: clip => {
    lastCaptureText = localClock.format(new Date(clip.endedAt)) + ' 已存盘';
    configureCapture();
  },
  onError: error => { toast(message(error)); configureCapture(); }
});

function renderSessions() {
  const select = $('session-select');
  const options = [new Option('录音档案', '')];
  for (const item of sessions) {
    const time = new Date(item.createdAt);
    const state = capture?.sessionId === item.id ? '本次录音' : item.kind === 'voice' ? '便签听写' : '工位录音';
    const label = calendarDate.format(time) + ' ' + localClock.format(time).slice(0, 5) + ' ' + state + (item.interrupted ? '（中断）' : '');
    options.push(new Option(label, item.id));
  }
  select.replaceChildren(...options);
  select.value = selectedSession;
  select.disabled = !sessions.length;
}

async function selectSession(sid, append = false) {
  const request = ++clipRequest;
  if (!append) {
    for (const entry of entries.values()) disposeClipPlayer(entry);
    selectedSession = sid;
    clips.clear();
    entries.clear();
    clipCount = 0;
    renderSessions();
    $('timeline-list').replaceChildren();
  }
  if (sid) {
    const result = await window.desk.clips(sid, append ? clips.size : 0);
    if (request !== clipRequest) return;
    clipCount = result.count;
    for (const clip of result.clips) showClip(clip, false);
  }
  updateTimelineFooter();
}

function updateTimelineFooter() {
  const list = $('timeline-list');
  list.querySelector(':scope > .empty')?.remove();
  $('more-clips').hidden = clips.size >= clipCount;
  $('timeline-count').hidden = !clipCount;
  $('timeline-count').textContent = clipCount + ' 段';
  if (!clips.size) {
    const active = capture?.kind === 'desk' && capture.sessionId === selectedSession;
    list.append(active ? emptyBlock('正在等待首段存盘', '到达分段间隔或按下「切段」后，这里会出现录音。', 'clock')
      : emptyBlock('暂无录音片段', '开始录音后，每一段都可以在这里回听和整理。', 'wave'));
  }
}

function disposeClipPlayer(entry) {
  const audio = entry.querySelector('audio');
  if (!audio) return;
  audio.pause();
  URL.revokeObjectURL(audio.src);
  audio.remove();
}

async function openPlayer(button, entry, clip) {
  const file = await window.desk.audio(clip.sid, clip.id);
  if (!entry.isConnected || entry.querySelector('audio')) return;
  const audio = node('audio');
  audio.controls = true;
  audio.src = URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
  audio.preload = 'metadata';
  entry.querySelector('.clip-player').replaceChildren(audio);
  button.hidden = true;
  await audio.play().catch(() => {});
}

function showClip(clip, prepend) {
  if (clip.sid !== selectedSession) return;
  const previous = entries.get(clip.id);
  if (previous && !clips.has(clip.id)) return;
  clips.set(clip.id, clip);
  const entry = node('details', 'timeline-entry');
  entry.dataset.status = clip.status;
  const automatic = !previous && (doing.has(clip.status) || (prepend && clip.status === 'saved'));
  if (prepend) for (const existing of entries.values()) if (existing.dataset.automatic === 'true') existing.open = false;
  entry.open = previous?.open ?? automatic;
  entry.dataset.automatic = previous?.dataset.automatic ?? String(automatic);
  const title = node('summary');
  title.addEventListener('click', () => { entry.dataset.automatic = 'false'; });
  const started = localClock.format(new Date(clip.startedAt));
  const ended = localClock.format(new Date(clip.endedAt));
  title.append(node('time', '', started + ' – ' + ended),
    node('span', 'clip-title', clip.report?.title || (clip.status === 'quiet' ? '环境安静' : '录音片段')),
    node('span', 'state-label', statusNames[clip.status] || '本机录音'));
  entry.append(title);
  const detail = node('div', 'clip-detail');
  if (clip.report) {
    detail.append(node('p', 'clip-summary', clip.report.summary));
    const breakdown = node('div', 'clip-breakdown');
    for (const [label, values] of [['重点', clip.report.highlights], ['已提取待办', clip.report.tasks.map(task =>
      [task.title, task.date, task.time].filter(Boolean).join(' '))]]) {
      if (values.length) {
        const block = node('div');
        const list = node('ul');
        list.append(...values.map(value => node('li', '', value)));
        block.append(node('h3', '', label), list);
        breakdown.append(block);
      }
    }
    if (breakdown.childElementCount) detail.append(breakdown);
  } else if (doing.has(clip.status)) {
    const feedback = node('p', 'live-copy');
    feedback.hidden = true;
    detail.append(feedback);
  }
  if (clip.strategy) {
    const languages = clip.strategy.languages.map(value => ({ zh: '中文', en: '英语' })[value] || value);
    detail.append(node('p', 'clip-strategy', [clip.strategy.label, languages.join(' / ') || '自动识别语言',
      clip.strategy.terms.join('、'), clip.strategy.warning].filter(Boolean).join(' · ')));
  }
  if (clip.error) detail.append(node('p', 'error-copy', clip.error));
  if (clip.transcript) {
    const transcript = node('details');
    transcript.append(node('summary', '', '查看转写原文'), node('p', 'clip-transcript', clip.transcript));
    detail.append(transcript);
  }
  const player = node('div', 'clip-player');
  const oldPlayer = previous?.querySelector('audio');
  if (oldPlayer) player.append(oldPlayer);
  detail.append(player);
  const actions = node('div', 'clip-actions');
  const replay = makeButton('回放', 'play');
  replay.hidden = !!oldPlayer;
  replay.addEventListener('click', () => run(() => openPlayer(replay, entry, clip), replay));
  actions.append(replay);
  if (!doing.has(clip.status) && clip.status !== 'done') {
    const retry = makeButton(clip.status === 'failed' ? '重试' : clip.transcript ? '整理文字' : '转写与整理', 'arrange');
    retry.addEventListener('click', () => run(async () => {
      entry.open = true;
      const result = await window.desk.process(clip.sid, clip.id);
      if (result.status === 'failed') toast(result.error);
    }, retry));
    actions.append(retry);
  }
  if (clip.transcript) {
    const note = makeButton('贴成便签', 'note');
    note.addEventListener('click', () => run(() => window.desk.clipNote(clip.sid, clip.id), note));
    actions.append(note);
  }
  detail.append(actions);
  entry.append(detail);
  entries.set(clip.id, entry);
  if (previous) previous.replaceWith(entry);
  else if (prepend) $('timeline-list').prepend(entry);
  else $('timeline-list').append(entry);
}

function clipUpdate(clip) {
  if (clip.sid !== selectedSession) return;
  const existing = clips.has(clip.id);
  if (!existing && !['saved', 'quiet'].includes(clip.status)) return;
  if (!existing) clipCount++;
  showClip(clip, !existing);
  updateTimelineFooter();
}

function clipPreview({ sid, id, kind, text }) {
  if (sid !== selectedSession) return;
  const preview = entries.get(id)?.querySelector('.live-copy');
  if (preview) {
    preview.hidden = !text;
    preview.textContent = (kind === 'transcript' ? '转写中  ' : '') + text;
  }
}

function plainText(html) {
  const scratch = document.createElement('template');
  scratch.innerHTML = String(html || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:div|p|li|blockquote)>/gi, '\n');
  return scratch.content.textContent.replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function makeCard(note) {
  const card = node('article', 'note-card bound-paper');
  const body = plainText(note.html);
  const label = note.title || body.split('\n')[0].slice(0, 32) || '无标题便签';
  card.dataset.id = note.id;
  card.dataset.color = note.color;
  card.tabIndex = 0;
  card.setAttribute('aria-label', label);
  const content = node('div', 'card-content');
  const top = node('div', 'card-topline');
  top.append(node('h3', '', label));
  if (note.pinned && tab !== 'trash') top.append(icon('pin'));
  content.append(top);
  const [firstLine, ...rest] = body.split('\n');
  const preview = firstLine.trim() === label.trim() ? rest.join('\n').trim() : body;
  if (preview || !body) content.append(node('p', 'card-preview', preview || '空白便签'));
  const bottom = node('footer', 'card-bottom');
  const time = new Date(note.deletedAt || note.updatedAt);
  bottom.append(node('time', 'card-time', Number.isNaN(+time) ? '' : calendarDate.format(time) + ' ' + localClock.format(time).slice(0, 5)));
  const actions = node('div', 'card-actions');
  const addAction = (name, text, symbol) => {
    const button = makeButton(text, symbol, 'icon-button card-action');
    button.dataset.action = name;
    actions.append(button);
    return button;
  };
  if (tab === 'trash') addAction('restore', '还原便签', 'restore');
  else {
    addAction('title', '从正文生成标题', 'title').disabled = !body || noteTitlesInFlight.has(note.id);
    addAction('pin', note.pinned ? '取消置顶' : '置顶', 'pin').setAttribute('aria-pressed', String(note.pinned));
    addAction('open', '打开便签', 'eye');
    addAction('remove', '移到回收站', 'trash');
  }
  bottom.append(actions);
  const binding = node('div', 'bindings');
  binding.setAttribute('aria-hidden', 'true');
  binding.append(...Array.from({ length: 3 }, () => node('span', 'binder-ring')));
  card.append(binding, content, bottom);
  return card;
}

function renderNotes() {
  const active = notes.filter(note => !note.deletedAt);
  const trash = notes.filter(note => note.deletedAt);
  const pinned = active.filter(note => note.pinned);
  $('all-count').textContent = active.length;
  $('pinned-count').textContent = pinned.length;
  $('trash-count').textContent = trash.length;
  $('show-all').hidden = tab === 'trash';
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tab === tab)));
  const query = $('search').value.trim().toLocaleLowerCase('zh-CN');
  const selection = { all: active, pinned, trash }[tab]
    .filter(note => !query || (note.title + '\n' + plainText(note.html)).toLocaleLowerCase('zh-CN').includes(query))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const grid = $('notes-grid');
  if (selection.length) {
    grid.replaceChildren(...selection.map(makeCard));
  } else {
    const holder = node('div', 'panel');
    holder.append(emptyBlock(query ? '没有匹配的便签' : '这里还没有便签',
      query ? '试试标题或正文中的其他关键词。' : tab === 'all' ? '新建便签开始记录。' : '', 'note'));
    grid.replaceChildren(holder);
  }
}

async function refreshNotes() {
  const serial = ++noteRequest;
  const fresh = await window.paper.list();
  if (serial !== noteRequest) return;
  notes = fresh;
  renderNotes();
}

async function cardAction(id, action, control) {
  if (action === 'open') await window.paper.open(id);
  if (action === 'restore') { await window.paper.restore(id); toast('已还原便签'); }
  if (action === 'remove') { await window.paper.remove(id); toast('已移到回收站'); }
  const note = notes.find(item => item.id === id);
  if (action === 'pin' && note) await window.paper.update(id, { pinned: !note.pinned });
  if (action === 'title' && note && !noteTitlesInFlight.has(id)) {
    if (!settings.routes.write) { showModelSetup(); toast('启用文字整理模型后即可生成标题'); return; }
    noteTitlesInFlight.add(id);
    if (control) control.disabled = true;
    toast('正在从正文生成标题');
    try {
      await window.desk.noteTitle(id, plainText(note.html), note.html);
      toast('已更新便签标题');
    } finally {
      noteTitlesInFlight.delete(id);
      await refreshNotes();
    }
  }
}

function makeTask(task) {
  const row = node('li', 'task-row');
  row.dataset.done = String(task.done);
  const check = node('input');
  check.type = 'checkbox';
  check.checked = task.done;
  check.setAttribute('aria-label', (task.done ? '恢复待办 ' : '完成待办 ') + task.title);
  check.addEventListener('change', () => run(async () => {
    try { await window.desk.task(task.id, { done: check.checked }); } catch (error) { check.checked = task.done; throw error; }
  }, check));
  const copy = node('div', 'task-text');
  const date = task.date ? [task.date, task.time].filter(Boolean).join(' ') : '日期待定';
  const meta = node('p', 'task-meta');
  meta.append(node('span', '', task.horizon === 'long' ? '长期' : '短期'), node('span', '', date));
  if (!task.done && task.date && task.date < dateKey()) meta.append(node('span', 'overdue', '已逾期'));
  copy.append(node('span', 'task-title', task.title), meta);
  const edit = makeButton('编辑待办和查看来源', 'pencil', 'icon-button');
  edit.addEventListener('click', () => editTask(task));
  row.append(check, copy, edit);
  return row;
}

function sortTasks(list, order = []) {
  const positions = new Map(order.map((id, index) => [id, index]));
  const rank = task => positions.get(task.id) ?? Number.MAX_SAFE_INTEGER;
  return [...list].sort((a, b) => Number(a.done) - Number(b.done) || rank(a) - rank(b)
    || (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99'));
}

function dayKey(scope) {
  return ['today', 'tomorrow'].includes(scope) ? dateKey(scope === 'tomorrow' ? 1 : 0) : '';
}

function renderTaskArea(target, state, date, limit) {
  const running = plansRunning.get(date);
  const plan = state.plan;
  const summary = running?.summary || (running ? '正在编排计划…' : plan?.summary);
  const { tasks: items } = state;
  target.replaceChildren();
  if (summary) target.append(node('p', 'plan-intro', summary));
  if (!items.length) {
    target.append(target.id === 'daily-items'
      ? emptyBlock((dailyScope === 'tomorrow' ? '明天' : '今天') + '还没有待办')
      : emptyBlock('暂无待办', '可以新建待办，也可以从便签和录音中提取。', 'calendar'));
    return;
  }
  const list = node('ul', 'task-list');
  list.append(...sortTasks(items, plan?.order).slice(0, limit).map(makeTask));
  target.append(list);
  if (items.length > limit) {
    const details = makeButton('查看全部 ' + items.length + ' 项', 'arrow-right', 'text-button');
    details.addEventListener('click', () => { planScope = dailyScope; showPage('plans'); });
    const footer = node('div', 'daily-actions');
    footer.append(details);
    target.append(footer);
  }
}

async function renderPlans() {
  const request = ++taskRequest;
  const activeDay = dayKey(dailyScope);
  const planDay = dayKey(planScope);
  const [daily, datedPlan] = await Promise.all([window.desk.day(activeDay), planDay && planDay !== activeDay ? window.desk.day(planDay) : null]);
  if (request !== taskRequest) return;
  for (const button of document.querySelectorAll('[data-day]')) {
    const scope = button.closest('#workbench') ? dailyScope : planScope;
    button.setAttribute('aria-pressed', String(button.dataset.day === scope));
  }
  const selected = planDay ? datedPlan || daily : { plan: null, tasks: planScope === 'all' ? tasks : tasks.filter(task => task.horizon === planScope) };
  const dailyPending = daily.tasks.filter(task => !task.done).length;
  const completed = selected.tasks.filter(task => task.done).length;
  $('plan-generate').hidden = !planDay;
  $('plan-generate').disabled = plansRunning.has(planDay) || completed === selected.tasks.length;
  $('daily-generate').disabled = plansRunning.has(activeDay) || !dailyPending;
  $('daily-count').textContent = dailyPending + ' 项待办';
  $('daily-count').hidden = !daily.tasks.length;
  if (planDay) {
    const date = new Date(planDay + 'T12:00:00');
    $('plan-period').textContent = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) + ' · ' +
      date.toLocaleDateString('zh-CN', { weekday: 'long' });
  } else $('plan-period').textContent = { short: '短期待办', long: '长期待办', all: '全部待办' }[planScope];
  $('plan-count').textContent = (selected.tasks.length - completed) + ' 项待办' + (completed ? ' · ' + completed + ' 项已完成' : '');
  $('plan-count').hidden = !selected.tasks.length;
  renderTaskArea($('daily-items'), daily, activeDay, 4);
  renderTaskArea($('plan-items'), selected, planDay);
}

async function generatePlan(scope) {
  const date = dayKey(scope);
  if (!date || plansRunning.has(date)) return;
  if (!settings.routes.write) { showModelSetup(); toast('启用文字整理模型后即可生成计划'); return; }
  plansRunning.set(date, { summary: '' });
  await renderPlans();
  try {
    await window.desk.plan(date);
    toast('计划已生成');
  } finally {
    plansRunning.delete(date);
    await renderPlans();
  }
}

function editTask(task, scope = '') {
  editedTask = task?.id || null;
  $('task-dialog-title').textContent = task ? '编辑待办' : '新建待办';
  $('task-title').value = task?.title || '';
  $('task-horizon').value = task?.horizon || (scope === 'long' ? 'long' : 'short');
  $('task-date').value = task ? task.date || '' : dayKey(scope);
  $('task-time').value = task?.time || '';
  $('task-time').disabled = !$('task-date').value;
  const source = $('task-source');
  source.replaceChildren();
  for (const item of task?.sources || []) {
    const link = makeButton(item.label || '查看来源', 'arrow-right', 'text-button');
    link.addEventListener('click', () => run(async () => {
      $('task-dialog').close();
      if (item.kind === 'note') {
        if (!await window.paper.open(item.id)) toast('来源便签已移到回收站');
      } else {
        showPage('workbench');
        await selectSession(item.sid);
        while (!entries.has(item.id) && clips.size < clipCount) await selectSession(item.sid, true);
        const entry = entries.get(item.id);
        if (entry) { entry.open = true; entry.scrollIntoView({ block: 'center' }); }
      }
    }));
    source.append(link, node('blockquote', '', item.evidence));
  }
  $('task-dialog').showModal();
}

function modelOptions(element, originals, fetched, kind) {
  const ids = [...new Set([...originals, ...fetched.filter(model => model.kind === kind).map(model => model.id)])];
  $(element).replaceChildren(...ids.map(id => new Option(id, id)));
}

function loadProvider() {
  const preset = settings.presets.find(item => item.id === serviceId);
  const saved = settings.connections[serviceId];
  for (const button of $('provider-list').children) button.setAttribute('aria-pressed', String(button.dataset.service === serviceId));
  $('provider-base').value = saved.base;
  $('provider-workspace').value = saved.workspace;
  $('workspace-field').hidden = !preset.workspace;
  $('provider-key').value = '';
  $('provider-key').placeholder = saved.hasKey ? '已保存，留空沿用' : '粘贴 API Key';
  $('key-hint').textContent = preset.custom ? '本机 HTTP 服务可以留空。其他密钥由 Windows 加密保存。' : '密钥由 Windows 加密保存在本机。';
  $('provider-text').value = saved.model;
  $('provider-speech').value = saved.speechModel;
  $('text-model-field').hidden = !preset.text.length && !preset.custom;
  $('speech-model-field').hidden = !preset.audio.length && !preset.custom;
  $('clear-key').hidden = !saved.hasKey;
  $('provider-state').textContent = preset.name;
  $('provider-status').textContent = saved.configured ? '已保存' : '';
  $('open-routing').hidden = !saved.configured;
  const fetched = discovered.get(serviceId) || [];
  modelOptions('text-models', preset.text, fetched, 'text');
  modelOptions('speech-models', preset.audio, fetched, 'audio');
  const choices = fetched.filter(model => model.kind === 'text' ? preset.text.length || preset.custom
    : model.kind === 'audio' && (preset.audio.length || preset.custom));
  $('fetched-models').replaceChildren(new Option('选择模型 ID', ''), ...choices.map(model => {
    const option = new Option(model.name === model.id ? model.id : model.name + ' / ' + model.id, model.id);
    option.dataset.kind = model.kind;
    return option;
  }));
  $('fetched-field').hidden = !choices.length;
}

function renderRoutes() {
  for (const [role, placeholder] of [['write', '关闭文字整理'], ['director', '跟随文字整理模型'], ['speech', '仅本地录音']]) {
    const select = $('route-' + role);
    const options = [new Option(placeholder, '')];
    for (const preset of settings.presets) {
      const connection = settings.connections[preset.id];
      const model = role === 'speech' ? connection.speechModel : connection.model;
      if (connection.configured && model) options.push(new Option(preset.name + '  /  ' + model, preset.id));
    }
    select.replaceChildren(...options);
    select.value = settings.routes[role];
    if (select.selectedIndex < 0) select.selectedIndex = 0;
  }
}

function renderSettings() {
  if (!$('provider-list').children.length) {
    $('provider-list').append(...settings.presets.map(preset => {
      const button = node('button', '', preset.name);
      button.dataset.service = preset.id;
      button.addEventListener('click', () => {
        serviceId = preset.id;
        $('provider-message').textContent = '';
        loadProvider();
      });
      return button;
    }));
  }
  loadProvider();
  renderRoutes();
  $('auto-process').checked = settings.recording.auto;
  $('skip-silence').checked = settings.recording.quiet;
  $('record-context').value = settings.recording.context;
}

function applySettings(next) {
  settings = next;
  $('interval').value = String(settings.recording.interval);
  configureCapture();
}

async function saveProvider(fetchModels = false, clearKey = false) {
  const id = serviceId;
  const output = $('provider-message');
  const form = $('provider-form');
  if (!form.reportValidity()) return;
  output.dataset.error = 'false';
  output.textContent = fetchModels ? '正在获取可用模型…' : '正在保存…';
  if (fetchModels) $('fetch-models').disabled = true;
  $('save-provider').disabled = true;
  try {
    const updated = await window.desk.saveConnection(id, {
      base: $('provider-base').value, workspace: $('provider-workspace').value, key: $('provider-key').value,
      model: $('provider-text').value, speechModel: $('provider-speech').value, clearKey
    });
    applySettings(updated);
    renderRoutes();
    if (serviceId === id) loadProvider();
    if (fetchModels) {
      const result = await window.desk.models(id);
      discovered.set(id, result);
      if (serviceId === id) {
        loadProvider();
        output.textContent = result.length ? '已读取 ' + result.length + ' 个模型。选择需要的模型后保存。' : '该账号暂未返回模型。可以直接填写已开通的模型 ID。';
      }
    } else if (serviceId === id) output.textContent = clearKey ? '已移除密钥。' : '已保存。在「模型分工」中启用。';
  } catch (error) {
    if (serviceId === id) {
      output.textContent = message(error);
      output.dataset.error = 'true';
    }
  } finally {
    $('fetch-models').disabled = false;
    $('save-provider').disabled = false;
  }
}

const recordingForm = () => ({
  interval: Number($('interval').value), auto: $('auto-process').checked, quiet: $('skip-silence').checked,
  context: $('record-context').value
});

function updateDraftControls() {
  const chars = [...$('quick-text').value.replace(/\s/g, '')].length;
  $('draft-count').textContent = chars.toLocaleString('zh-CN') + ' 字';
  for (const button of $('quick-form').querySelectorAll('button[type=submit]')) {
    button.disabled = postingDraft || !chars;
  }
}

async function saveQuickDraft() {
  clearTimeout(draftTimer);
  const snapshot = $('quick-text').value;
  try {
    await window.desk.saveDraft(snapshot);
    if (snapshot === $('quick-text').value) $('draft-state').textContent = snapshot ? '已存草稿' : '草稿';
  } catch (error) {
    if (snapshot === $('quick-text').value) $('draft-state').textContent = '草稿待保存';
    throw error;
  }
}

async function postQuickDraft(organize) {
  if (postingDraft) return;
  const snapshot = $('quick-text').value;
  if (!snapshot.trim()) throw new Error('先写下便签内容');
  if (organize && !settings.routes.write) {
    showModelSetup();
    toast('启用文字整理模型后即可整理草稿');
    return;
  }
  postingDraft = true;
  updateDraftControls();
  try {
    await window.desk.quickNote(snapshot, organize);
    if ($('quick-text').value === snapshot) {
      $('quick-text').value = '';
      updateDraftControls();
    }
    await saveQuickDraft();
  } finally {
    postingDraft = false;
    updateDraftControls();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-page]').forEach(control => control.addEventListener('click', event => {
    event.preventDefault();
    if (control.closest('.daily-panel') && control.dataset.page === 'plans') planScope = dailyScope;
    showPage(control.dataset.page, control.dataset.openSettings);
  }));
  const settingsTabs = [...document.querySelectorAll('.settings-tabs [role=tab]')];
  settingsTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showSettingsTab(tab.id.slice(4)));
    tab.addEventListener('keydown', event => {
      const last = settingsTabs.length - 1;
      const next = { ArrowRight: (i + 1) % settingsTabs.length, ArrowLeft: (i + last) % settingsTabs.length, Home: 0, End: last }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      showSettingsTab(settingsTabs[next].id.slice(4), true);
    });
  });
  $('open-routing').addEventListener('click', () => showSettingsTab('routing', true));
  for (const button of [$('new'), ...document.querySelectorAll('[data-new-note]')]) {
    button.addEventListener('click', () => run(() => window.paper.create(), button));
  }
  for (const action of ['minimize', 'maximize', 'close']) $(action).addEventListener('click', () => window.paper.managerWindow(action));
  $('data-folder').addEventListener('click', () => run(async () => {
    const error = await window.paper.openDataFolder();
    if (error) toast(error);
  }));
  $('shortcuts').addEventListener('click', () => $('help-dialog').showModal());
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === 'n') { event.preventDefault(); $('new').click(); }
    if (key === 'f') { event.preventDefault(); showPage('notes'); $('search').select(); }
    if (key === 's' && page === 'notes') { event.preventDefault(); $('export').click(); }
  });

  $('record').addEventListener('click', () => run(async () => {
    if (recorder.phase === 'recording') await recorder.pause();
    else if (recorder.phase === 'paused') await recorder.resume();
    else {
      lastCaptureText = '';
      await recorder.start();
    }
  }).finally(configureCapture));
  $('cut').addEventListener('click', () => run(() => recorder.cut(), $('cut')).finally(configureCapture));
  $('stop').addEventListener('click', () => run(() => recorder.stop(), $('stop')).finally(configureCapture));
  $('interval').addEventListener('change', () => run(async () => {
    try { await window.desk.saveRecording({ ...settings.recording, interval: Number($('interval').value) }); }
    catch (error) { $('interval').value = String(settings.recording.interval); throw error; }
  }));
  $('session-select').addEventListener('change', () => run(() => selectSession($('session-select').value)));
  $('more-clips').addEventListener('click', () => run(() => selectSession(selectedSession, true), $('more-clips')));
  $('quick-text').addEventListener('input', () => {
    updateDraftControls();
    $('draft-state').textContent = '保存中';
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => run(saveQuickDraft), 450);
  });
  $('quick-text').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    const pin = $('quick-form').querySelector('[value=pin]');
    if (!event.repeat && !pin.disabled) $('quick-form').requestSubmit(pin);
  });
  $('quick-form').addEventListener('submit', event => {
    event.preventDefault();
    run(() => postQuickDraft(event.submitter?.value === 'organize'));
  });

  $('search').addEventListener('input', renderNotes);
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    tab = button.dataset.tab;
    $('search').value = '';
    renderNotes();
  }));
  $('show-all').addEventListener('click', () => run(() => window.paper.showAll()));
  $('export').addEventListener('click', () => run(async () => {
    if (!(await window.paper.exportNotes()).canceled) toast('便签备份已保存');
  }, $('export')));
  $('notes-grid').addEventListener('click', event => {
    const card = event.target.closest('.note-card');
    const control = event.target.closest('[data-action]');
    if (card && (control || tab !== 'trash')) run(() => cardAction(card.dataset.id, control?.dataset.action || 'open', control));
  });
  $('notes-grid').addEventListener('keydown', event => {
    const card = event.target.closest('.note-card');
    if (card && card === event.target && event.key === 'Enter' && tab !== 'trash') run(() => window.paper.open(card.dataset.id));
  });

  document.querySelectorAll('[data-day]').forEach(button => button.addEventListener('click', () => {
    if (button.closest('#workbench')) dailyScope = button.dataset.day;
    else planScope = button.dataset.day;
    run(renderPlans);
  }));
  $('daily-generate').addEventListener('click', () => run(() => generatePlan(dailyScope)));
  $('plan-generate').addEventListener('click', () => run(() => generatePlan(planScope)));
  $('daily-add').addEventListener('click', () => editTask(null, dailyScope));
  $('new-task').addEventListener('click', () => editTask(null, planScope));
  $('task-date').addEventListener('change', () => {
    $('task-time').disabled = !$('task-date').value;
    if ($('task-time').disabled) $('task-time').value = '';
  });
  $('task-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      await window.desk.task(editedTask, { title: $('task-title').value, horizon: $('task-horizon').value,
        date: $('task-date').value, time: $('task-time').value });
      $('task-dialog').close();
    }, $('task-form').querySelector('[type=submit]'));
  });

  $('provider-form').addEventListener('submit', event => { event.preventDefault(); void saveProvider(); });
  $('fetch-models').addEventListener('click', () => saveProvider(true));
  $('fetched-models').addEventListener('change', event => {
    const choice = event.target.selectedOptions[0];
    if (choice?.value) $(choice.dataset.kind === 'audio' ? 'provider-speech' : 'provider-text').value = choice.value;
  });
  $('clear-key').addEventListener('click', () => saveProvider(false, true));
  $('routing-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      await window.desk.saveRoutes({ write: $('route-write').value, director: $('route-director').value, speech: $('route-speech').value });
      toast('模型分工已启用');
    }, event.submitter);
  });
  $('recording-form').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
      await window.desk.saveRecording(recordingForm());
      toast('录音设置已保存');
    }, event.submitter);
  });

  window.paper.onChanged(() => run(refreshNotes));
  window.desk.onSettings(applySettings);
  window.desk.onShowSettings(showModelSetup);
  window.desk.onSessions(next => {
    sessions = next;
    if (selectedSession && !sessions.some(item => item.id === selectedSession)) run(() => selectSession(sessions[0]?.id || ''));
    else renderSessions();
  });
  window.desk.onCapture(state => {
    capture = state;
    configureCapture();
    if (state?.kind === 'desk' && state.phase === 'opening' && selectedSession !== state.sessionId) run(() => selectSession(state.sessionId));
  });
  window.desk.onCaptureCommand(({ action, reason }) => run(async () => {
    if (action === 'pause') await recorder.pause();
    else await recorder.stop();
    if (reason) toast(reason);
  }));
  window.desk.onClip(clipUpdate);
  window.desk.onPreview(clipPreview);
  window.desk.onTasks(next => { tasks = next; run(renderPlans); });
  window.desk.onPlanPreview(({ date, summary }) => {
    const active = plansRunning.get(date);
    if (!active) return;
    active.summary = summary;
    for (const [section, scope] of [['daily-items', dailyScope], ['plan-items', planScope]]) {
      const output = $(section).querySelector('.plan-intro');
      if (output && date === dayKey(scope)) output.textContent = summary;
    }
  });
  window.paper.onFlush(async requestId => {
    let ok = false;
    try { await Promise.all([recorder.stop(), saveQuickDraft()]); ok = true; } catch (error) { toast(message(error)); }
    finally { window.paper.flushDone(requestId, ok); }
  });
  connectWaveDecoder();
}

async function initialize() {
  try {
    $('meter').append(...Array.from({ length: 24 }, () => node('span')));
    updateDate();
    setInterval(() => { if (!document.hidden) updateDate(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateDate(); });
    bindEvents();
    const initial = await window.desk.state();
    capture = initial.capture;
    sessions = initial.sessions;
    tasks = initial.tasks;
    $('quick-text').value = initial.draft;
    updateDraftControls();
    $('draft-state').textContent = initial.draft ? '已存草稿' : '草稿';
    applySettings(initial.settings);
    renderSettings();
    await Promise.all([refreshNotes(), renderPlans(), selectSession(initial.capture?.sessionId || sessions[0]?.id || '')]);
    window.__managerReady = true;
  } catch (error) {
    console.error(error);
    toast('工作台加载失败：' + message(error));
  }
}

initialize();
