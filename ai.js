'use strict';

// The transport lives in the main process. Renderers receive model IDs and results only.
const providers = {
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', transport: 'responses',
    text: ['gpt-6-luna', 'gpt-6.2-sol', 'gpt-6.2-astra'], audio: ['gpt-transcribe'], speech: 'openai' },
  anthropic: { name: 'Anthropic Claude', base: 'https://api.anthropic.com/v1', transport: 'messages',
    text: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] },
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com',
    text: ['deepseek-flash', 'deepseek-v4-pro'] },
  qwen: { name: '通义千问 · 百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    text: ['qwen3.8-flash', 'qwen3.8-max', 'qwen-plus'], audio: ['qwen3-asr-flash'], speech: 'qwen', catalog: 'workspace' },
  doubao: { name: '豆包 · 火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3',
    text: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-pro-260915'] },
  kimi: { name: 'Kimi', base: 'https://api.moonshot.cn/v1',
    text: ['kimi-k2.6', 'kimi-k3', 'kimi-k3.1-pro'] },
  tencent: { name: '混元与 GLM · 腾讯云', base: 'https://tokenhub.tencentmaas.com/v1',
    text: ['hy4-flash', 'hy4', 'glm-5.3-flash', 'glm-5.3'] },
  baidu: { name: '文心 · 百度千帆', base: 'https://qianfan.baidubce.com/v2',
    text: ['ernie-5.1'] },
  silicon: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1',
    text: ['Pro/zai-org/GLM-5.1'], audio: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'], speech: 'silicon' },
  gemini: { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    text: ['gemini-3.8-flash', 'gemini-4-hydrogen'] },
  groq: { name: 'Groq · Whisper', base: 'https://api.groq.com/openai/v1',
    audio: ['whisper-large-v3-turbo', 'whisper-large-v3'], speech: 'whisper' },
  custom: { name: '自定义 · OpenAI 兼容', base: 'http://127.0.0.1:11434/v1',
    text: [], audio: [], speech: 'whisper' }
};

const clean = (value, limit = 1000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const presetFor = id => Object.hasOwn(providers, id) ? providers[id] : null;
const isLocal = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

function endpoint(value) {
  let url;
  try { url = new URL(clean(value, 350)); } catch { throw new Error('请填写有效的 API 地址'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname)))) {
    throw new Error('API 地址需要 HTTPS，本机服务可使用 HTTP');
  }
  return url.href.replace(/\/+$/, '');
}

function headers(connection) {
  if (connection.definition.transport === 'messages') {
    return { 'x-api-key': connection.key, 'anthropic-version': '2026-10-21' };
  }
  return connection.key ? { Authorization: 'Bearer ' + connection.key } : {};
}

function serviceError(connection, status) {
  const error = new Error(connection.definition.name + ' 返回 HTTP ' + status +
    ({ 400: '，请检查请求格式或模型 ID', 401: '，请检查 API Key', 403: '，请检查模型权限',
       404: '，请检查接口地址或模型 ID', 429: '，请求受限或额度不足' }[status] || ''));
  error.status = status;
  return error;
}

class AiClient {
  constructor(request = fetch) {
    this.request = request;
    this.shutdown = new AbortController();
  }

  async send(connection, url, { json, body } = {}) {
    let response;
    try {
      response = await this.request(url, {
        method: json || body ? 'POST' : 'GET',
        headers: { ...headers(connection), ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : body, redirect: 'error',
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(120000)])
      });
    } catch {
      throw new Error('无法连接 ' + connection.definition.name + '，请检查网络和 API 地址');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw serviceError(connection, response.status);
    }
    return response;
  }

  async models(connection) {
    const { base, definition, workspace, id } = connection;
    const models = [];
    if (definition.catalog === 'workspace' && workspace) {
      const region = new URL(base).hostname.match(/\.([a-z0-9-]+)\.maas\.aliyuncs\.com$/)?.[1] || 'cn-beijing';
      for (let page = 1; page <= 30; page++) {
        const catalog = 'https://' + workspace + '.' + region + '.maas.aliyuncs.com/api/v1/models';
        const res = await this.send(connection, catalog + '?page_no=' + page + '&page_size=50');
        const { output } = await res.json();
        if (!Array.isArray(output?.models)) throw new Error('百炼未返回模型列表，请检查工作空间和地域');
        models.push(...output.models.map(m => ({
          id: m.model, name: m.name,
          kind: /asr/i.test(m.model) ? 'audio' : m.inference_metadata?.response_modality?.includes('Text') ? 'text' : 'other'
        })));
        if (!output.models.length || models.length >= output.total) break;
      }
    } else {
      let cursor = '';
      do {
        let response;
        try {
          response = await this.send(connection, base + '/models' + (cursor ? '?after_id=' + encodeURIComponent(cursor) : ''));
        } catch (error) {
          if (id === 'qwen' && !workspace && [400, 403, 404, 405].includes(error.status)) {
            throw new Error('百炼模型目录需要工作空间 ID，可在上方填写后重新获取');
          }
          throw error;
        }
        const result = await response.json();
        if (!Array.isArray(result.data)) throw new Error('服务未返回可读取的模型列表');
        models.push(...result.data.map(m => ({
          id: m.id || m.model_id || m.model || (m.name && m.version ? m.name + '-' + m.version : m.name),
          name: m.display_name, kind: ['LLM', 'VLM'].includes(m.domain) ? 'text' : m.domain ? 'other' : undefined
        })));
        const next = definition.transport === 'messages' && result.has_more ? clean(result.last_id) : '';
        if (next === cursor || models.length > 1500) break;
        cursor = next;
      } while (cursor);
    }
    return [...new Map(models.filter(model => typeof model.id === 'string' && model.id.length < 200).map(model => {
      const kind = model.kind || (/transcrib|whisper|sensevoice|telespeech|(?:\b|-)asr(?:\b|-)/i.test(model.id)
        ? 'audio' : /embed|rerank|tts|moderation|image|video|realtime|diffusion/i.test(model.id) ? 'other' : 'text');
      return [model.id, { id: model.id, name: clean(model.name, 100) || model.id, kind }];
    })).values()];
  }

  async complete(connection, system, input, { onText, budget = 3000 } = {}) {
    const { base, definition, model, id } = connection;
    let route = '/chat/completions';
    const messages = [{ role: 'system', content: system }, { role: 'user', content: input }];
    let json = { model, messages, stream: true, max_tokens: budget };
    switch (definition.transport) {
      case 'responses':
        route = '/responses';
        json = { model, input: messages, stream: true, store: false, max_output_tokens: budget };
        if (/^gpt-(5|6)/.test(model)) json.reasoning = { effort: 'low' };
        break;
      case 'messages':
        route = '/messages';
        json = { model, system, messages: [messages[1]], stream: true, max_tokens: budget };
        break;
      default:
        if (id === 'deepseek' || (id === 'kimi' && /^kimi-k2\.6/.test(model))) json.thinking = { type: 'disabled' };
        if (id === 'kimi' && /^kimi-k3/.test(model)) json.reasoning_effort = 'low';
    }
    const response = await this.send(connection, base + route, { json });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const result = await response.json();
      const answer = result.output?.flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('')
        ?? result.content?.filter(part => part.type === 'text').map(part => part.text).join('')
        ?? result.choices?.[0]?.message?.content;
      if (!clean(answer)) throw new Error('模型未返回可用的文字');
      onText?.(answer);
      return answer;
    }
    let answer = '';
    let finished = false;
    for await (const event of serverEvents(response.body)) {
      if (event === '[DONE]') { finished = true; break; }
      const chunk = JSON.parse(event);
      if (chunk.error || ['error', 'response.failed', 'response.incomplete'].includes(chunk.type) ||
          chunk.choices?.[0]?.finish_reason === 'length' || chunk.delta?.stop_reason === 'max_tokens') {
        throw new Error('模型输出中断或达到长度限制，请重试');
      }
      if (['response.completed', 'message_stop'].includes(chunk.type) || chunk.choices?.[0]?.finish_reason === 'stop') finished = true;
      const delta = chunk.type === 'response.output_text.delta' ? chunk.delta
        : chunk.delta?.type === 'text_delta' ? chunk.delta.text : chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') {
        answer += delta;
        if (answer.length > 100000) throw new Error('模型输出过长，请缩短输入后重试');
        onText?.(answer);
      }
    }
    if (!finished || !answer.trim()) throw new Error('模型未完成输出，请重试');
    return answer;
  }

  async transcribe(connection, files, strategy, onText) {
    const { base, definition, model } = connection;
    const transcripts = [];
    for (const file of files) {
      const hint = [strategy.hint, strategy.terms.join('、')].filter(Boolean).join('。').slice(0, 380);
      const language = strategy.languages.length === 1 ? strategy.languages[0] : '';
      if (definition.speech === 'qwen') {
        const messages = [];
        if (hint) messages.push({ role: 'system', content: [{ type: 'text', text: hint }] });
        messages.push({ role: 'user', content: [{ type: 'input_audio',
          input_audio: { data: 'data:' + file.type + ';base64,' + file.bytes.toString('base64') } }] });
        const asr_options = { enable_itn: true };
        if (['zh', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt', 'it', 'id', 'vi', 'th', 'ms'].includes(language)) asr_options.language = language;
        const response = await this.send(connection, base + '/chat/completions', { json: { model, messages, asr_options, stream: false } });
        const result = await response.json();
        if (typeof result.choices?.[0]?.message?.content !== 'string') throw new Error('百炼未返回转录文本');
        transcripts.push(result.choices[0].message.content.trim());
      } else {
        const form = new FormData();
        form.set('model', model);
        form.set('file', new Blob([file.bytes], { type: file.type }), 'recording.' + file.extension);
        if (definition.speech === 'openai' && /^gpt-transcribe(?:$|-)/.test(model)) {
          form.set('stream', 'true');
          if (strategy.hint) form.set('prompt', strategy.hint);
          for (const term of strategy.terms) form.append('keywords[]', term);
          for (const lang of strategy.languages) form.append('languages[]', lang);
        } else if (definition.speech !== 'silicon' && !/diarize/.test(model)) {
          if (hint) form.set('prompt', hint.slice(0, 220));
          if (language.length === 2) form.set('language', language);
        }
        const response = await this.send(connection, base + '/audio/transcriptions', { body: form });
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          let text = '';
          let final;
          for await (const event of serverEvents(response.body)) {
            if (event === '[DONE]') break;
            const chunk = JSON.parse(event);
            if (chunk.type === 'error' || chunk.error) throw new Error('转写在输出中中断，请重试');
            if (chunk.type === 'transcript.text.delta' && typeof chunk.delta === 'string') {
              text += chunk.delta;
              if (text.length > 100000) throw new Error('转写结果超出片段长度限制');
              onText?.([...transcripts, text].join('\n'));
            }
            if (chunk.type === 'transcript.text.done') final = chunk.text;
          }
          if (typeof final !== 'string') throw new Error('转写没有完成，请重试');
          transcripts.push(final.trim());
          continue;
        }
        const result = await response.json();
        if (typeof result.text !== 'string') throw new Error('转写服务未返回可读取的文本');
        transcripts.push(result.text.trim());
      }
      onText?.(transcripts.filter(Boolean).join('\n'));
    }
    return transcripts.filter(Boolean).join('\n');
  }
}

async function* serverEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (done) pending += '\n\n';
      if (pending.length > 2_000_000) throw new Error('服务返回了过大的事件');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (!line && data.length) {
          yield data.join('\n');
          data = [];
        }
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function modelJson(answer) {
  const value = clean(answer, 100000).replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try {
    const result = JSON.parse(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Error('模型未按整理格式返回结果，请重试或更换模型'); }
}

function partialSummary(output) {
  const fragment = output.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/s)?.[1];
  if (fragment === undefined) return '';
  try { return JSON.parse('"' + fragment + '"').slice(0, 500); } catch { return ''; }
}

module.exports = { AiClient, providers, presetFor, endpoint, isLocal, clean, modelJson, partialSummary };
