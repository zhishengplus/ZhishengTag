'use strict';
// Exercises the bundled runtime and its real Chromium windows with isolated test data.
const { BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { dateKey } = require('./desk');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await test()) return;
    await sleep(80);
  }
  throw new Error(`超时: ${message}`);
}
async function run(win, script) { return win.webContents.executeJavaScript(script, true); }

function streamFixture(events, delay = 0) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const event of events) {
        const encoded = encoder.encode('data: ' + JSON.stringify(event) + '\r\n\r\n');
        controller.enqueue(encoded.slice(0, 13));
        controller.enqueue(encoded.slice(13));
        if (delay) await sleep(delay);
      }
      controller.close();
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function exerciseDesk({ board, note, desk, store, snapshot, pass }) {
  const click = (win, id) => run(win, 'document.getElementById(' + JSON.stringify(id) + ').click()');
  const select = (win, selector) => run(win, 'document.querySelector(' + JSON.stringify(selector) + ').click()');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = dateKey(tomorrow);
  const today = dateKey();
  const speechText = 'ZT 明天下午三点发送报价。本月完成资料迁移。';
  const shortTask = { title: '发送报价', horizon: 'short', date: nextDay, time: '15:00', evidence: '明天下午三点发送报价' };
  const longTask = { title: '完成资料迁移', horizon: 'long', date: '', time: '', evidence: '本月完成资料迁移' };
  const audioReport = { summary: '已确认报价与迁移安排。', title: 'ZT 交付跟进', highlights: ['报价明天下午三点发送'], tasks: [shortTask, longTask] };
  let transcriptions = 0;
  let strategies = 0;
  let latestVoice;
  let checkedWav = false;
  let failOnce = false;
  const auth = 'Bearer zhisheng-smoke-fixture';
  desk.ai.request = async (url, options) => {
    if (!url.endsWith('/messages')) assert.equal(options.headers.Authorization, auth);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-transcribe' }, { id: 'fixture-text-model' }] });
    if (url.endsWith('/audio/transcriptions')) {
      if (failOnce) { failOnce = false; return new Response('mock unavailable', { status: 503 }); }
      const file = options.body.get('file');
      assert(file.size > 200);
      assert.equal(file.type, 'audio/webm');
      const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      assert.deepEqual([...header], [0x1a, 0x45, 0xdf, 0xa3]);
      assert.equal(options.body.get('keywords[]'), 'ZT');
      assert.equal(options.body.get('languages[]'), 'zh');
      transcriptions++;
      return streamFixture([{ type: 'transcript.text.delta', delta: speechText },
        { type: 'transcript.text.done', text: speechText }]);
    }
    const request = JSON.parse(options.body);
    if (url.endsWith('/messages')) {
      assert.equal(options.headers['x-api-key'], 'zhisheng-smoke-fixture');
      assert.equal(options.headers['anthropic-version'], '2026-10-21');
      assert.equal(request.messages[0].role, 'user');
      return streamFixture([{ type: 'content_block_delta', delta: { type: 'text_delta', text: '{"title":"周报发送清单"}' } },
        { type: 'message_stop' }]);
    }
    if (request.model === 'qwen3-asr-flash') {
      const media = request.messages.at(-1).content[0].input_audio.data;
      assert(media.startsWith('data:audio/wav;base64,'));
      const wave = Buffer.from(media.slice(media.indexOf(',') + 1), 'base64');
      assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wave.readUInt32LE(24), 16000);
      assert.equal(request.asr_options.language, 'zh');
      assert.match(request.messages[0].content[0].text, /ZT/);
      checkedWav = true;
      return Response.json({ choices: [{ message: { content: speechText } }] });
    }
    assert.match(url, /\/responses$/);
    assert.equal(request.store, false);
    const input = JSON.parse(request.input[1].content);
    let fixture;
    let delay = 0;
    if (input.purpose) {
      assert.match(input.context, /ZT/);
      strategies++;
      fixture = { mode: 'meeting', languages: ['zh'], terms: ['ZT', '未出现的术语'], hint: '项目 ZT 工位记录' };
    } else if (input.tasks) {
      assert(input.tasks.some(task => task.title === (input.date === nextDay ? '发送报价' : '发周报')));
      fixture = { summary: input.date === nextDay ? '明天下午先确认报价后发出。' : '今天下午四点发送周报。',
        order: [input.tasks[0].id, 'imaginary-id'] };
    } else if (input.material === speechText) {
      fixture = audioReport;
      delay = 300;
    } else {
      assert.match(input.material, /发周报/);
      fixture = { summary: '今天发送周报。', title: '周报安排', highlights: ['下午四点发出'], tasks: [
        { title: '发周报', horizon: 'short', date: today, time: '16:00', evidence: '今天16:00发周报' },
        { title: '虚构任务', horizon: 'short', date: today, time: '', evidence: '这一句从未出现' }
      ] };
    }
    const output = JSON.stringify(fixture);
    return streamFixture([{ type: 'response.output_text.delta', delta: output.slice(0, 25) },
      { type: 'response.output_text.delta', delta: output.slice(25) }, { type: 'response.completed' }], delay);
  };

  await select(board, '.primary-nav [data-page=workbench]');
  const seam = await run(board, "parseFloat(getComputedStyle(document.querySelector('.workbench-grid')).columnGap)");
  assert.equal(seam, 3);
  await snapshot(board, '05-workbench.png');
  const desktopBounds = board.getBounds();
  for (const [width, height] of [[1024, 700], [790, 660], [760, 560]]) {
    board.setSize(width, height);
    await until(() => run(board, 'innerWidth === ' + width), '窗口完成重新排版');
    const fits = await run(board, `(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect();
      const workspace = document.querySelector('.workspace');
      const paper = rect('.quick-panel'), recording = rect('.recorder-module'), daily = rect('.daily-panel');
      return workspace.scrollWidth === workspace.clientWidth && paper.width > recording.width &&
        recording.left === daily.left && daily.top > recording.bottom && rect('#record').bottom < innerHeight &&
        rect('#quick-text').height > 140 && rect('.quick-footer').bottom < innerHeight;
    })()`);
    assert(fits, '纸页、录音、计划在窗口范围内 ' + width);
    if (width === 790) await snapshot(board, '05-compact.png');
    if (width === 760) {
      for (const view of ['notes', 'plans', 'settings']) {
        await select(board, '.sidebar [data-page=' + view + ']');
        assert(await run(board, "document.querySelector('.workspace').scrollWidth === document.querySelector('.workspace').clientWidth"), '最小窗口完整显示 ' + view);
      }
      await select(board, '.primary-nav [data-page=workbench]');
    }
  }
  board.setBounds(desktopBounds);
  await click(board, 'capture-settings');
  assert(await run(board, "document.getElementById('tab-recording').getAttribute('aria-selected') === 'true' && document.activeElement.id === 'tab-recording'"));
  await run(board, "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  assert(await run(board, "document.activeElement.id === 'tab-services' && !document.getElementById('settings-services').hidden"));
  await run(board, "document.activeElement.blur()");
  await snapshot(board, '06-settings.png');
  pass('三种工位窗口、最小尺寸四个页面与设置页键盘切换');
  await run(board, "document.getElementById('provider-key').value='zhisheng-smoke-fixture'");
  await click(board, 'fetch-models');
  await until(() => run(board, "Array.from(document.getElementById('fetched-models').options).some(o => o.value === 'fixture-text-model')"), '实时获取并展示模型');
  await click(board, 'open-routing');
  assert(await run(board, "!document.getElementById('settings-routing').hidden"));
  await run(board, "document.getElementById('route-write').value='openai'; document.getElementById('route-speech').value='openai'; document.querySelector('#routing-form button').click()");
  await until(() => desk.notices().write && desk.notices().speech, '启用文字和语音路线');
  assert(!fs.readFileSync(desk.settingsPath, 'utf8').includes('zhisheng-smoke-fixture'));
  assert(!JSON.stringify(await run(board, 'window.desk.state()')).includes('zhisheng-smoke-fixture'));
  await click(board, 'tab-recording');
  await run(board, "document.getElementById('record-context').value='ZT 记录测试'; document.getElementById('skip-silence').checked=false; document.querySelector('#recording-form button').click()");
  await until(() => desk.config.recording.context === 'ZT 记录测试', '设置转录术语');
  pass('实时模型目录、分工路由和 Windows 密钥加密');

  await select(board, '.primary-nav [data-page=workbench]');
  await click(board, 'record');
  await until(() => desk.captureState()?.phase === 'recording', '麦克风已进入录音');
  await until(() => run(board, "document.getElementById('capture-time').textContent !== '00:00:00'"), '计时器正在推进');
  await until(() => run(board, "Number(document.getElementById('meter').getAttribute('aria-valuenow')) > -72"), '电平由输入音频驱动');
  const sid = desk.captureState().sessionId;
  await click(board, 'cut');
  await until(() => run(board, "document.querySelector('.live-copy')?.textContent?.includes('已确认')"), '摘要增量进入时间轴');
  await until(() => desk.clips(sid).clips.some(clip => clip.status === 'done'), '首个片段已整理');
  assert(desk.tasks().some(task => task.date === nextDay && task.time === '15:00'));
  assert(desk.tasks().some(task => task.horizon === 'long'));
  failOnce = true;
  board.hide();
  await click(board, 'record');
  await until(() => desk.captureState()?.phase === 'paused', '暂停并封存片段');
  await until(() => desk.clips(sid).clips.some(clip => clip.status === 'failed'), '网络失败保留原始片段');
  board.show();
  const failed = desk.clips(sid).clips.find(clip => clip.status === 'failed');
  assert(desk.audio(sid, failed.id).bytes.length > 200);
  await until(() => run(board, "Array.from(document.querySelectorAll('.clip-actions button')).some(b=>b.textContent==='重试')"), '时间轴显示重试操作');
  await run(board, "Array.from(document.querySelectorAll('.clip-actions button')).find(b=>b.textContent==='重试').click()");
  await until(() => desk.clip(sid, failed.id).status === 'done', '网络恢复后重试');
  await click(board, 'record');
  await until(() => desk.captureState()?.phase === 'recording', '恢复录音');
  await sleep(1200);
  await click(board, 'stop');
  await until(() => !desk.captureState(), '停止并关闭会话');
  await until(() => desk.clips(sid).clips.every(clip => clip.status === 'done'), '队列整理结束', 12000);
  assert.equal(desk.clips(sid).count, 3);
  assert.equal(desk.tasks().length, 2);
  assert.equal(strategies, 4);
  assert.equal(transcriptions, 3);
  assert(desk.clips(sid).clips.every(clip => clip.strategy.terms.length === 1));
  await select(board, '#workbench [data-day=tomorrow]');
  await until(() => run(board, "!document.getElementById('daily-generate').disabled"), '明日待办可以编排');
  await click(board, 'daily-generate');
  await until(() => desk.getPlan(nextDay), '明日计划已保存');
  assert.equal(desk.getPlan(nextDay).order.length, 1);
  await click(board, 'daily-add');
  assert.equal(await run(board, "document.getElementById('task-date').value"), nextDay);
  await select(board, '#task-dialog [data-close-dialog]');
  await select(board, '.daily-panel [data-page=plans]');
  await until(() => run(board, "document.querySelector('#plans [data-day=tomorrow]').getAttribute('aria-pressed')==='true' && document.getElementById('plan-count').textContent.includes('1 项')"), '明日计划与统计对应日期');
  await snapshot(board, '09-plans.png');
  await select(board, '.primary-nav [data-page=workbench]');
  await run(board, `(() => {
    const input = document.getElementById('quick-text');
    input.value = ['交付跟进', '', '报价单明天下午三点发出，发送前再确认一次金额。', '资料迁移安排在本月，先整理需要同步的文件。'].join('\\n');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until(() => run(board, "document.getElementById('draft-state').textContent === '已存草稿'"), '示例草稿已存');
  await snapshot(board, '07-recording-review.png');
  pass('每日计划快捷添加、日期联动和待办统计');
  pass('录音、暂停、恢复、切段、策略指导、实时摘要、期限归纳与计划');

  await run(note, "const el = document.getElementById('editor'); el.textContent='今天16:00发周报'; el.dispatchEvent(new Event('input', {bubbles:true}));");
  await click(note, 'organize');
  await until(() => run(note, "!document.getElementById('apply-report').hidden"), '文字整理预览');
  assert.match(await run(note, "document.getElementById('editor').innerText"), /今天16:00/);
  await click(note, 'apply-report');
  await until(() => desk.tasks().some(task => task.title === '发周报'), '应用文字整理并写入计划');
  assert(!desk.tasks().some(task => task.title === '虚构任务'));
  await select(board, '#workbench [data-day=today]');
  await until(() => run(board, "document.querySelector('#workbench [data-day=today]').getAttribute('aria-pressed')==='true' && !document.getElementById('daily-generate').disabled"), '今日待办可以编排');
  await click(board, 'daily-generate');
  await until(() => desk.getPlan(today), '今日短期事项编排');
  await run(board, "const draft = document.getElementById('quick-text'); draft.value='今天16:00发周报'; draft.dispatchEvent(new Event('input',{bubbles:true}))");
  await until(() => desk.draft() === '今天16:00发周报', '工位草稿自动保存');
  await select(board, '#quick-form [value=organize]');
  let quickNote;
  await until(async () => {
    quickNote = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('organize=1'));
    return quickNote && await run(quickNote, "!document.getElementById('apply-report').hidden");
  }, '工位纸页一键生成整理预览');
  const quickId = await run(quickNote, "new URLSearchParams(location.search).get('id')");
  await run(board, 'window.paper.remove(' + JSON.stringify(quickId) + ')');
  await until(() => desk.draft() === '', '贴出草稿后清理工作台纸页');
  await run(board, "document.getElementById('quick-text').value='下次打开时继续写。'; document.getElementById('quick-text').dispatchEvent(new Event('input',{bubbles:true}))");
  await until(() => desk.draft() === '下次打开时继续写。', '保留下一份草稿');
  pass('环装工位草稿、窄窗口布局与一键整理');
  const noteId = await run(note, "new URLSearchParams(location.search).get('id')");
  desk.saveConnection('anthropic', { key: 'zhisheng-smoke-fixture', model: 'claude-haiku-5-5' });
  desk.saveRoutes({ write: 'anthropic', speech: 'openai' });
  await select(board, '.primary-nav [data-page=notes]');
  await select(board, '[data-id="' + noteId + '"] [data-action=title]');
  await until(() => store.notes.find(item => item.id === noteId)?.title === '周报发送清单', '便签列表 AI 标题');
  const completed = desk.tasks().find(task => task.title === '发周报');
  await desk.saveTask(completed.id, { done: true });
  pass('文字预览、来源校验、任务去重与列表 AI 改标题');

  await select(board, '.primary-nav [data-page=workbench]');
  await run(board, `(() => {
    const input = document.getElementById('quick-text');
    input.value = '周报校对清单\\n发送前核对本周进展与下周交付日期。';
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));
  })()`);
  let hotkeyNote;
  await until(() => { hotkeyNote = store.notes.find(n => !n.deletedAt && n.html.includes('周报校对清单')); return hotkeyNote; }, '快捷键贴出工位草稿');
  await until(() => run(board, "document.getElementById('draft-count').textContent === '0 字'"), '贴出后字数随草稿清零');
  await select(board, '.primary-nav [data-page=notes]');
  await run(board, "document.getElementById('search').value='周报'; document.getElementById('search').dispatchEvent(new Event('input'))");
  await until(() => run(board, "document.querySelectorAll('.note-card').length === 2"), '搜索两张周报便签');
  await snapshot(board, '10-library.png');
  await run(board, 'window.paper.remove(' + JSON.stringify(hotkeyNote.id) + ')');
  await select(board, '.primary-nav [data-page=workbench]');
  await run(board, "document.getElementById('quick-text').value='下次打开时继续写。'; document.getElementById('quick-text').dispatchEvent(new Event('input',{bubbles:true}))");
  await until(() => desk.draft() === '下次打开时继续写。', '恢复待重启核对的草稿');
  pass('纸页字数、快捷贴出和便签簿呈现');

  desk.saveConnection('qwen', { key: 'zhisheng-smoke-fixture', model: 'qwen3.8-flash', speechModel: 'qwen3-asr-flash' });
  desk.saveRoutes({ write: 'openai', speech: 'qwen' });
  await click(note, 'voice');
  await until(() => desk.captureState()?.kind === 'voice' && desk.captureState()?.phase === 'recording', '便签听写开始');
  latestVoice = desk.captureState().sessionId;
  await sleep(1150);
  await click(note, 'voice');
  await until(() => run(note, "!document.getElementById('apply-voice').hidden"), '听写结果可插入', 12000);
  await click(note, 'apply-voice');
  await until(() => store.notes.find(item => item.id === noteId)?.html.includes(speechText), '听写原文追加');
  assert(checkedWav);
  assert.equal(desk.clips(latestVoice).clips[0].status, 'done');
  await snapshot(note, '08-desktop-note.png');
  pass('便签听写、本地 WAV 转换与原文追加');
  return { sid, nextDay, latestVoice };
}

module.exports = function smoke({ app, store, desk, manager, noteWindows, flushAndQuit }) {
  (async () => {
    const restarting = process.argv.includes('--restart');
    const output = process.env.PAPER_TEST_REPORT || path.join(app.getPath('userData'), 'verification');
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    const pass = (name, detail = '') => { results.push({ name, result: 'PASS', detail }); console.log(`PASS ${name} ${detail}`); };
    const snapshot = async (win, name) => {
      win.focus();
      await run(win, "document.getElementById('toast').hidden = true");
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(190);
          const image = await win.webContents.capturePage();
          if (image.isEmpty()) continue;
          fs.writeFileSync(path.join(output, name), image.toPNG());
          return;
        }
        throw new Error('无法生成窗口截图 ' + name);
      } finally {
        await run(win, "document.getElementById('toast').hidden = false");
      }
    };
    if (!restarting) {
      await until(() => noteWindows.size === 1, '创建第一张便签');
      const first = [...noteWindows.values()][0];
      await until(() => run(first, 'window.__noteReady === true'), '第一张便签加载');
      const firstId = [...noteWindows.keys()][0];
      await snapshot(first, '01-welcome.png');
      pass('真实窗口启动与中文界面', `${first.getBounds().width}×${first.getBounds().height}`);
      const originalSize = first.getSize();
      for (const [width, height] of [[280, 320], [560, 370]]) {
        first.setSize(width, height);
        await until(() => run(first, 'innerWidth === ' + width), '便签尺寸已应用');
        await run(first, "document.getElementById('color').click()");
        assert(await run(first, `(() => {
          const box = id => document.getElementById(id).getBoundingClientRect();
          const palette = box('color-popover'), trigger = box('color');
          return palette.width > 0 && palette.bottom <= trigger.top && palette.left >= 0 && palette.top >= 0 &&
            box('editor-scroll').height > 85 && box('organize').right <= innerWidth &&
            Array.from(document.querySelectorAll('.format')).every(b => b.getBoundingClientRect().width >= 21);
        })()`));
        await run(first, "document.getElementById('color').click()");
      }
      first.setSize(...originalSize);
      pass('桌面便签最小与宽幅布局、格式键和纸色弹层');

      const editResult = await run(first, `(() => {
        const editor = document.getElementById('editor');
        document.getElementById('title').value = '周末的小清单';
        document.getElementById('title').dispatchEvent(new Event('input', { bubbles: true }));
        editor.innerHTML = '<div>买一束花</div><div>给久违的朋友打个电话</div>';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        const range = document.createRange(); range.selectNodeContents(editor.firstElementChild);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.querySelector('[data-command="bold"]').click();
        return {title:document.getElementById('title').value,html:editor.innerHTML,active:document.activeElement.tagName};
      })()`);
      assert.equal(editResult.title, '周末的小清单');
      assert(editResult.html.includes('<b>买一束花</b>'));
      try {
        await until(() => store.notes[0].html.includes('<b>买一束花</b>') && store.notes[0].title === '周末的小清单', '自动保存中文和加粗');
      } catch (error) {
        console.error('SAVE_DEBUG_STORE', JSON.stringify({ title: store.notes[0].title, color: store.notes[0].color }));
        console.error('SAVE_DEBUG_RENDERER', JSON.stringify(await run(first, `({title:document.getElementById('title').value,status:document.getElementById('save-text').textContent,ready:window.__noteReady})`)));
        throw error;
      }
      pass('中文输入、富文本与自动保存', store.notes[0].html);

      await run(first, `(() => {
        const editor = document.getElementById('editor'); editor.focus();
        const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        editor.appendChild(document.createTextNode('<img src=x onerror=alert(1)>纯文本'));
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '纯文本' }));
        return true;
      })()`);
      await until(() => run(first, `document.getElementById('editor').innerText.includes('纯文本')`), '编辑器文本插入');
      await sleep(1100);
      await until(() => store.notes[0].html.includes('纯文本'), '纯文本输入保存');
      assert(!store.notes[0].html.includes('<img'));
      pass('纯文本输入保存与格式白名单');

      await run(first, `(() => { document.querySelector('[data-color="sage"]').click(); return true; })()`);
      await until(() => store.notes[0].color === 'sage', '纸张颜色');
      await run(first, `(() => { document.getElementById('pin').click(); document.getElementById('font-up').click(); return true; })()`);
      await until(() => store.notes[0].fontSize === 17 && store.notes[0].pinned && first.isAlwaysOnTop(), '置顶、原生窗口置顶和字号');
      pass('纸张颜色、字号与原生置顶');
      const bounds = first.getBounds();
      first.setBounds({ x: bounds.x - 45, y: bounds.y + 35, width: 390, height: 480 });
      await until(() => store.notes[0].bounds.width === 390 && store.notes[0].bounds.height === 480 && store.notes[0].bounds.x === bounds.x - 45, '窗口位置与大小');
      pass('窗口移动与尺寸持久化', JSON.stringify(store.notes[0].bounds));

      await run(first, 'window.paper.create(window.paperNoteId || new URLSearchParams(location.search).get("id"))');
      await until(() => noteWindows.size === 2, '新建第二张便签');
      const secondId = [...noteWindows.keys()].find(id => id !== firstId);
      const second = noteWindows.get(secondId);
      await until(() => run(second, 'window.__noteReady === true'), '第二张便签加载');
      await run(second, `(() => {
        const editor = document.getElementById('editor');
        editor.innerHTML = '<div>一张可以找回的便签</div><img src=x onerror=alert(1)><script>window.injected=true<\/script>';
        editor.dispatchEvent(new Event('input', { bubbles: true })); return true;
      })()`);
      await until(() => store.notes.find(n => n.id === secondId)?.html.includes('一张可以找回'), '第二张内容保存');
      assert(!store.notes.find(n => n.id === secondId).html.includes('<script'));
      assert(!store.notes.find(n => n.id === secondId).html.includes('<img'));
      assert.equal(await run(second, 'window.injected === true'), false);
      assert.equal(store.notes.find(n => n.id === secondId).color, 'sage');
      pass('多窗口新建与脚本注入防护');
      await sleep(750);
      await snapshot(first, '02-edited-note.png');

      await run(first, 'window.paper.showManager()');
      const board = await (async () => {
        let found;
        await until(() => { found = BrowserWindow.getAllWindows().find(w => w !== first && w !== second && w.webContents.getURL().includes('manager.html')); return !!found; }, '管理页创建');
        await until(() => run(found, 'window.__managerReady === true && document.querySelectorAll(".note-card").length === 2'), '管理页展示两张便签');
        return found;
      })();
      await run(board, 'document.querySelector(".primary-nav [data-page=notes]").click()');
      await run(board, `(() => { const input = document.getElementById('search'); input.value = '一束花'; input.dispatchEvent(new Event('input', { bubbles: true })); return document.querySelectorAll('.note-card').length; })()`);
      assert.equal(await run(board, 'document.querySelectorAll(".note-card").length'), 1);
      await run(board, `(() => { const input = document.getElementById('search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-tab="pinned"]').click(); return true; })()`);
      assert.equal(await run(board, 'document.querySelectorAll(".note-card").length'), 1);
      await run(board, 'document.querySelector(\'[data-tab="all"]\').click()');
      pass('管理页总览、搜索与置顶筛选');
      await sleep(250);
      await snapshot(board, '03-manager.png');

      await run(board, `document.querySelector('[data-id="${secondId}"] [data-action="remove"]').click()`);
      await until(() => !!store.notes.find(n => n.id === secondId)?.deletedAt && !second.isVisible(), '移入回收站并隐藏窗口');
      await run(board, `document.querySelector('[data-tab="trash"]').click()`);
      assert.equal(await run(board, 'document.querySelectorAll(".note-card").length'), 1);
      await run(board, `document.querySelector('[data-id="${secondId}"] [data-action="restore"]').click()`);
      await until(() => !store.notes.find(n => n.id === secondId)?.deletedAt && second.isVisible(), '从回收站还原');
      pass('回收站隐藏、列表展示与完整还原');
      await run(board, 'document.querySelector(\'[data-tab="all"]\').click()');

      const oldDialog = dialog.showSaveDialog;
      const backupPath = path.join(output, 'backup-test.json');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: backupPath });
      try {
        const result = await run(board, 'window.paper.exportNotes()');
        assert.equal(result.canceled, false);
        const exported = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        assert.equal(exported.notes.length, 2);
        pass('完整 JSON 备份（自动化指定保存路径）');
      } finally { dialog.showSaveDialog = oldDialog; }

      await run(first, `(() => { document.getElementById('close').click(); return true; })()`);
      await until(() => store.notes.find(n => n.id === firstId).hidden && !first.isVisible(), '关闭只收起');
      await run(board, 'window.paper.showAll()');
      await until(() => store.notes.every(n => !n.hidden) && first.isVisible() && second.isVisible(), '展开全部便签');
      pass('关闭不删除与全部展开');
      assert(fs.existsSync(store.file));
      assert(fs.existsSync(store.backup));
      const disk = JSON.parse(fs.readFileSync(store.file, 'utf8'));
      assert.equal(disk.notes.length, 2);
      pass('原子数据文件与上一版本备份');
      const recorded = await exerciseDesk({ board, note: second, desk, store, snapshot, pass });
      fs.writeFileSync(path.join(output, 'phase1.json'), JSON.stringify({ results, firstId, secondId, recorded, bounds: store.notes.find(n => n.id === firstId).bounds }, null, 2));
      app.relaunch({ args: [...(process.defaultApp ? [__dirname] : []), '--smoke-test', '--restart'] });
      await flushAndQuit();
    } else {
      const previous = JSON.parse(fs.readFileSync(path.join(output, 'phase1.json'), 'utf8'));
      await until(() => noteWindows.size === 2, '重启后恢复两张便签');
      for (const win of noteWindows.values()) await until(() => run(win, 'window.__noteReady === true'), '重启后窗口就绪');
      const original = store.notes.find(n => n.id === previous.firstId);
      assert.equal(original.title, '周末的小清单');
      assert(original.html.includes('<b>买一束花</b>'));
      assert(original.html.includes('纯文本'));
      assert.equal(original.color, 'sage');
      assert.equal(original.fontSize, 17);
      assert.equal(original.pinned, true);
      assert.equal(original.hidden, false);
      assert.deepEqual(original.bounds, previous.bounds);
      assert.equal(store.notes.find(n => n.id === previous.secondId).deletedAt, null);
      pass('真实进程重启后内容、格式、颜色、置顶、尺寸、位置与回收站还原均保留', JSON.stringify(original.bounds));
      const { sid, nextDay, latestVoice } = previous.recorded;
      assert.equal(desk.clips(sid).count, 3);
      assert(desk.clips(sid).clips.every(clip => clip.status === 'done'));
      assert(desk.clips(latestVoice).clips[0].transcript.includes('发送报价'));
      assert(desk.getPlan(nextDay));
      assert(desk.tasks().some(task => task.title === '发周报' && task.done));
      assert.equal(desk.draft(), '下次打开时继续写。');
      pass('真实进程重启后录音、转写、计划、完成状态和草稿均保留');
      const first = noteWindows.get(previous.firstId);
      await snapshot(first, '04-after-restart.png');
      const report = { app: 'ZhishengTag', version: app.getVersion(), result: 'PASS', testedAt: new Date().toISOString(), phases: [previous.results, results], runtime: process.versions };
      fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
      console.log(`ALL_TESTS_PASSED ${output}`);
      await flushAndQuit();
    }
  })().catch(error => {
    const output = process.env.PAPER_TEST_REPORT || app.getPath('userData');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    console.error('SMOKE_TEST_FAILED', error);
    app.exit(1);
  });
};
