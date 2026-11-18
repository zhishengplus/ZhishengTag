'use strict';

const $ = id => document.getElementById(id);
const editor = $('editor');
const title = $('title');
let note = null;
let dirty = false;
let saving = false;
let savePromise = null;
let saveTimer = null;
let toastTimer = null;
let saveFailed = false;
let resultDraft = null;
let draftRequest = null;
let draftBusy = false;
let lastVoice = null;
let processedVoice = null;
let silentStop = false;

const voiceRecorder = new DeskRecorder('voice', {
  onState: recorder => {
    const active = recorder.phase !== 'idle';
    $('voice').dataset.recording = String(active);
    $('voice').disabled = recorder.phase === 'opening';
    $('voice-label').textContent = recorder.phase === 'opening' ? '打开麦克风…' : active ? '结束听写' : '听写';
    $('organize').disabled = active || draftBusy;
    if (!active && !silentStop && lastVoice && processedVoice !== lastVoice.id) {
      processedVoice = lastVoice.id;
      void prepareVoice(lastVoice);
    }
  },
  onLevel: (_db, elapsed) => {
    if (voiceRecorder.phase !== 'recording' || document.hidden) return;
    const seconds = Math.floor(elapsed / 1000);
    $('voice-label').textContent = '结束听写 ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  },
  onClip: clip => { lastVoice = clip; },
  onError: error => toast(errorMessage(error))
});

function errorMessage(error) {
  return String(error?.message || error).replace(/^Error invoking remote method .*?: Error:\s*/, '');
}

function act(operation) {
  return Promise.resolve().then(operation).catch(error => toast(errorMessage(error)));
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 1800);
}

function status(message, state = '') {
  $('save-text').textContent = message;
  $('save-state').className = `save-state ${state}`;
}

function countCharacters() {
  const count = [...editor.innerText.replace(/\s/g, '')].length;
  $('char-count').textContent = `${count.toLocaleString('zh-CN')} 字`;
}

function setColor(color) {
  document.body.dataset.color = color;
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('selected', s.dataset.color === color);
    s.setAttribute('aria-pressed', String(s.dataset.color === color));
  });
}

function renderNote(incoming, force = false) {
  const previousColor = note?.color;
  note = incoming;
  setColor(note.color);
  $('pin').setAttribute('aria-pressed', String(note.pinned));
  $('pin').title = note.pinned ? '取消置顶 · Ctrl+Shift+P' : '置顶 · Ctrl+Shift+P';
  $('font-size').value = note.fontSize;
  $('font-size').textContent = note.fontSize;
  editor.style.fontSize = `${note.fontSize}px`;
  $('font-down').disabled = note.fontSize <= 13;
  $('font-up').disabled = note.fontSize >= 24;
  if (force || (!dirty && title.value !== note.title && document.activeElement !== title)) title.value = note.title;
  if (force || (!dirty && editor.innerHTML !== note.html && document.activeElement !== editor)) {
    editor.innerHTML = note.html;
    countCharacters();
  }
  document.title = note.title || '枳生Ai桌签';
  if (previousColor && previousColor !== note.color) {
    // Color selection is a property change, not a content edit.
    countCharacters();
  }
}

function scheduleSave() {
  dirty = true;
  status('正在保存', 'saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 650);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (saving) {
    await savePromise.catch(() => {});
    if (saveFailed) return;
    return dirty ? saveNow() : undefined;
  }
  if (!dirty || !note) return;
  const snapshot = { title: title.value, html: editor.innerHTML, content: true };
  saving = true;
  status('正在保存', 'saving');
  savePromise = window.paper.update(note.id, snapshot);
  try {
    const saved = await savePromise;
    if (snapshot.title === title.value && snapshot.html === editor.innerHTML) {
      dirty = false;
      note = saved;
      saveFailed = false;
      status('已自动保存');
    } else {
      dirty = true;
    }
  } catch (error) {
    dirty = true;
    saveFailed = true;
    status('保存失败，自动重试', 'error');
    console.error('Save failed:', error);
    saveTimer = setTimeout(saveNow, 1800);
  } finally {
    saving = false;
  }
  if (dirty && !saveFailed) await saveNow();
}

async function ensureSaved() {
  await saveNow();
  if (dirty || saveFailed) throw new Error('便签尚未保存，请检查本地数据盘');
}

function resultStatus(message, error = false) {
  $('result-status').textContent = message;
  $('result-status').dataset.error = String(error);
}

function openResult(titleText) {
  closePopovers();
  resultDraft = null;
  $('result-title').textContent = titleText;
  $('result-content').replaceChildren();
  for (const id of ['apply-report', 'apply-voice', 'retry-voice', 'result-setup']) $(id).hidden = true;
  if (!$('result-dialog').open) $('result-dialog').showModal();
}

function copyNode(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function showResult(draft) {
  if (!$('result-dialog').open) return;
  resultDraft = draft;
  $('apply-report').hidden = !draft.report;
  $('apply-report').textContent = draft.transcript ? '追加整理' : '应用整理';
  $('apply-voice').hidden = !draft.transcript;
  const output = $('result-content');
  output.replaceChildren();
  if (draft.report) {
    const report = draft.report;
    output.append(copyNode('h3', report.title), copyNode('p', report.summary));
    for (const [label, values] of [['重点', report.highlights], ['待办', report.tasks.map(task =>
      [task.horizon === 'long' ? '长期' : '短期', task.title, task.date, task.time].filter(Boolean).join('  '))]]) {
      if (values.length) {
        const list = document.createElement('ul');
        list.append(...values.map(value => copyNode('li', value)));
        output.append(copyNode('h3', label), list);
      }
    }
  }
  if (draft.transcript) {
    const details = document.createElement('details');
    details.open = !draft.report;
    details.append(copyNode('summary', '听写原文'), copyNode('p', draft.transcript));
    output.append(details);
  }
  resultStatus(draft.transcript ? '录音已归档，可插入原文或整理结果。' : '应用后更新这张便签，并将待办写入计划。');
}

async function organizeNote() {
  if (draftBusy || voiceRecorder.session) return;
  const source = editor.innerText.trim();
  if (!source) return toast('先写下要整理的内容');
  draftBusy = true;
  $('organize').disabled = true;
  const request = crypto.randomUUID();
  draftRequest = request;
  openResult('整理预览');
  resultStatus('正在读取便签…');
  try {
    await ensureSaved();
    showResult(await window.desk.organizeNote(source, request));
  } catch (error) {
    resultStatus(errorMessage(error), true);
    $('result-setup').hidden = false;
  } finally {
    draftBusy = false;
    draftRequest = null;
    $('organize').disabled = false;
  }
}

async function prepareVoice(clip) {
  if (draftBusy) return;
  draftBusy = true;
  $('voice').disabled = true;
  $('organize').disabled = true;
  openResult('听写整理');
  resultStatus('已存盘，正在准备转录…');
  try {
    await ensureSaved();
    showResult(await window.desk.voiceNote(clip.sid, clip.id));
  } catch (error) {
    resultStatus(errorMessage(error), true);
    $('retry-voice').hidden = false;
    $('result-setup').hidden = false;
  } finally {
    draftBusy = false;
    $('voice').disabled = false;
    $('organize').disabled = false;
  }
}

async function applyResult(choice) {
  if (!resultDraft || draftBusy) return;
  draftBusy = true;
  $('apply-report').disabled = $('apply-voice').disabled = true;
  try {
    await ensureSaved();
    const saved = await window.desk.applyNote(resultDraft.token, choice);
    renderNote(saved, true);
    $('result-dialog').close();
    toast('整理结果已保存');
  } catch (error) {
    resultStatus(errorMessage(error), true);
  } finally {
    draftBusy = false;
    $('apply-report').disabled = $('apply-voice').disabled = false;
  }
}

async function stopVoiceSilently() {
  silentStop = true;
  try { await voiceRecorder.stop(); }
  finally { silentStop = false; }
}

function format(command, value = null) {
  closePopovers();
  editor.focus();
  if (command === 'formatBlock') {
    const inQuote = document.queryCommandValue(command).toLowerCase() === 'blockquote';
    document.execCommand(command, false, inQuote ? 'div' : 'blockquote');
  } else {
    document.execCommand(command, false, value);
  }
  countCharacters();
  scheduleSave();
  refreshFormatStates();
}

function refreshFormatStates() {
  document.querySelectorAll('.format').forEach(button => {
    const command = button.dataset.command;
    if (command === 'undo' || command === 'redo') return;
    try {
      const pressed = command === 'formatBlock' ? document.queryCommandValue(command).toLowerCase() === 'blockquote' : document.queryCommandState(command);
      button.setAttribute('aria-pressed', String(pressed));
    } catch (_) { /* Browser selection may not exist yet. */ }
  });
}

function closePopovers() {
  $('settings').hidden = true;
  $('color-popover').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
  $('color').setAttribute('aria-expanded', 'false');
}

function togglePopover(id, trigger) {
  const wasHidden = $(id).hidden;
  closePopovers();
  $(id).hidden = !wasHidden;
  $(trigger).setAttribute('aria-expanded', String(wasHidden));
}

function focusEnd() {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function bindEvents() {
  editor.addEventListener('input', () => { countCharacters(); scheduleSave(); });
  title.addEventListener('input', scheduleSave);
  editor.addEventListener('paste', event => {
    event.preventDefault();
    const plainText = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    document.execCommand('insertText', false, plainText);
  });
  editor.addEventListener('drop', event => {
    event.preventDefault();
    const plainText = event.dataTransfer?.getData('text/plain');
    if (plainText) document.execCommand('insertText', false, plainText);
  });
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection.rangeCount && editor.contains(selection.anchorNode)) refreshFormatStates();
  });
  document.querySelectorAll('.format').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => format(button.dataset.command, button.dataset.value));
  });
  $('new').addEventListener('click', async () => { await saveNow(); await window.paper.create(note.id); });
  $('pin').addEventListener('click', async () => {
    note = await window.paper.update(note.id, { pinned: !note.pinned });
    renderNote(note);
    toast(note.pinned ? '已置顶 · 始终留在最前面' : '已取消置顶');
  });
  $('close').addEventListener('click', () => act(async () => {
    await stopVoiceSilently();
    await ensureSaved();
    await window.paper.hide();
  }));
  $('manage').addEventListener('click', async () => { closePopovers(); await saveNow(); await window.paper.showManager(); });
  $('ai-setup').addEventListener('click', () => { closePopovers(); act(() => window.desk.settingsPage()); });
  $('result-setup').addEventListener('click', () => act(() => window.desk.settingsPage()));
  $('result-close').addEventListener('click', () => $('result-dialog').close());
  $('organize').addEventListener('click', organizeNote);
  $('voice').addEventListener('click', () => act(async () => {
    if (draftBusy) return;
    if (voiceRecorder.session) await voiceRecorder.stop();
    else {
      lastVoice = null;
      await voiceRecorder.start();
    }
  }));
  $('retry-voice').addEventListener('click', () => { if (lastVoice) void prepareVoice(lastVoice); });
  $('apply-report').addEventListener('click', () => applyResult('report'));
  $('apply-voice').addEventListener('click', () => applyResult('transcript'));
  window.desk.onNotePreview(({ requestId, summary }) => {
    if (requestId === draftRequest && $('result-dialog').open) $('result-content').textContent = summary;
  });
  window.desk.onClip(clip => {
    if (draftBusy && !draftRequest && $('result-dialog').open && lastVoice?.id === clip.id) {
      const stages = { queued: '已排队…', directing: '正在制定转录策略…', transcribing: '正在识别语音…', organizing: '正在整理摘要和待办…' };
      if (stages[clip.status]) resultStatus(stages[clip.status]);
    }
  });
  window.desk.onPreview(({ id, text }) => {
    if (draftBusy && !draftRequest && $('result-dialog').open && lastVoice?.id === id) $('result-content').textContent = text;
  });
  window.desk.onCaptureCommand(({ action, reason }) => act(async () => {
    if (action === 'pause') await voiceRecorder.pause();
    else if (action === 'stop-silent') await stopVoiceSilently();
    else await voiceRecorder.stop();
    if (reason) toast(reason);
  }));
  $('export').addEventListener('click', async () => {
    closePopovers(); await saveNow();
    const result = await window.paper.exportNotes();
    if (!result.canceled) toast('备份完成');
  });
  $('remove').addEventListener('click', async () => {
    closePopovers();
    await act(async () => { await stopVoiceSilently(); await ensureSaved(); await window.paper.remove(note.id); });
  });
  $('more').addEventListener('click', () => togglePopover('settings', 'more'));
  $('color').addEventListener('click', () => togglePopover('color-popover', 'color'));
  document.querySelectorAll('.swatch').forEach(button => button.addEventListener('click', async () => {
    note = await window.paper.update(note.id, { color: button.dataset.color });
    renderNote(note); closePopovers();
  }));
  for (const [id, delta] of [['font-down', -1], ['font-up', 1]]) {
    $(id).addEventListener('click', async () => {
      note = await window.paper.update(note.id, { fontSize: note.fontSize + delta });
      renderNote(note);
    });
  }
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.popover, #more, #color')) closePopovers();
  });
  $('editor-scroll').addEventListener('click', event => {
    if (event.target === $('editor-scroll')) focusEnd();
  });
  document.addEventListener('keydown', event => {
    const modifier = event.ctrlKey || event.metaKey;
    if ($('result-dialog').open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!$('settings').hidden || !$('color-popover').hidden) { closePopovers(); return; }
      $('close').click();
    }
    if (modifier && event.key.toLowerCase() === 'n') {
      event.preventDefault(); saveNow().then(() => window.paper.create(note.id));
    }
    if (modifier && event.key.toLowerCase() === 's') {
      event.preventDefault(); saveNow().then(() => toast('已保存到本机'));
    }
    if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault(); $('pin').click();
    }
    if (modifier && event.key === 'Enter') {
      event.preventDefault(); saveNow().then(() => window.paper.create(note.id));
    }
    if (event.key === 'Tab' && document.activeElement === editor) {
      event.preventDefault(); document.execCommand('insertText', false, '\t');
    }
  });
  $('resize-grip').addEventListener('pointerdown', event => {
    event.preventDefault();
    const start = { x: event.screenX, y: event.screenY, width: window.outerWidth, height: window.outerHeight };
    $('resize-grip').setPointerCapture(event.pointerId);
    const move = e => window.resizeTo(Math.max(280, Math.min(1200, start.width + e.screenX - start.x)), Math.max(320, Math.min(1200, start.height + e.screenY - start.y)));
    const end = () => {
      $('resize-grip').removeEventListener('pointermove', move);
      $('resize-grip').removeEventListener('pointerup', end);
      $('resize-grip').removeEventListener('pointercancel', end);
    };
    $('resize-grip').addEventListener('pointermove', move);
    $('resize-grip').addEventListener('pointerup', end);
    $('resize-grip').addEventListener('pointercancel', end);
  });
  window.addEventListener('blur', () => { document.body.classList.remove('focused'); });
  window.addEventListener('focus', () => document.body.classList.add('focused'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
  window.paper.onFocus(focused => document.body.classList.toggle('focused', focused));
  window.paper.onFlush(async requestId => {
    let ok = false;
    try { await stopVoiceSilently(); await ensureSaved(); ok = true; }
    catch (error) { toast(errorMessage(error)); }
    finally { window.paper.flushDone(requestId, ok); }
  });
  window.paper.onChanged(({ reason, note: incoming }) => {
    if (incoming.id !== note?.id) return;
    if (reason === 'update') {
      const contentChanged = incoming.title !== note.title || incoming.html !== note.html;
      if (contentChanged && document.activeElement === editor && incoming.html !== note.html) {
        // A manager operation never interrupts active typing.
        const { title: nextTitle, html: nextHtml, ...properties } = incoming;
        renderNote({ ...note, ...properties });
      } else {
        renderNote(incoming, !dirty && document.activeElement !== editor);
      }
    }
  });
}

async function initialize() {
  const query = new URLSearchParams(location.search);
  const id = query.get('id');
  if (!id) { status('无法打开便签', 'error'); return; }
  try {
    document.execCommand('defaultParagraphSeparator', false, 'div');
    const initial = await window.paper.get(id);
    renderNote(initial, true);
    bindEvents();
    status('已自动保存');
    document.body.classList.add('focused');
    window.__noteReady = true;
    if (query.get('organize') === '1') void organizeNote();
  } catch (error) {
    status('打开失败，请重试', 'error');
    console.error(error);
  }
}

initialize();
