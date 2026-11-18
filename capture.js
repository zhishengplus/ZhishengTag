'use strict';

class DeskRecorder {
  constructor(kind, { onState = () => {}, onLevel = () => {}, onError = () => {}, onClip = () => {} } = {}) {
    this.kind = kind;
    this.onState = onState;
    this.onLevel = onLevel;
    this.onError = onError;
    this.onClip = onClip;
    this.phase = 'idle';
    this.session = null;
    this.part = null;
    this.elapsed = 0;
    this.unsaved = [];
    this.operations = Promise.resolve();
  }

  run(operation) {
    const result = this.operations.then(operation);
    this.operations = result.catch(error => this.onError(error));
    return result;
  }

  setState(phase) {
    this.phase = phase;
    this.onState(this);
  }

  get duration() {
    return this.elapsed + (this.part ? performance.now() - this.part.clock : 0);
  }

  async openMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('此运行环境无法访问麦克风');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
    } catch (error) {
      throw new Error({
        NotAllowedError: '麦克风权限未开启，请检查 Windows 麦克风设置',
        NotFoundError: '没有找到麦克风，请连接后重试',
        NotReadableError: '无法读取麦克风，请检查设备是否被独占'
      }[error.name] || '无法打开麦克风，请检查输入设备');
    }
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.pause().catch(() => {});
        this.onError(new Error('麦克风已断开，录音暂停'));
      });
    }
    try {
      this.context = new AudioContext({ latencyHint: 'playback' });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.context.createMediaStreamSource(this.stream).connect(this.analyser);
      this.context.resume().catch(() => {});
    } catch {
      // Capture still works on devices that can't supply a meter.
      this.analyser = null;
    }
    this.meterTimer = setInterval(() => this.sample(), 250);
  }

  releaseMicrophone() {
    clearInterval(this.meterTimer);
    this.stream?.getTracks().forEach(track => track.stop());
    this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.onLevel(-72, this.duration);
  }

  sample() {
    let db = -72;
    if (this.analyser && this.context.state === 'running' && this.part) {
      this.analyser.getFloatTimeDomainData(this.samples);
      let power = 0;
      for (const sample of this.samples) power += sample * sample;
      db = Math.max(-72, 10 * Math.log10(power / this.samples.length));
      this.part.samples++;
      if (db >= -52) this.part.audible++;
    }
    this.onLevel(db, this.duration);
  }

  arm() {
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(value => MediaRecorder.isTypeSupported(value));
    if (!mimeType) throw new Error('当前运行时不支持 Opus 录音');
    const recorder = new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 24000 });
    const chunks = [];
    const startedAt = Date.now();
    const part = {
      id: startedAt + '-' + crypto.randomUUID(), recorder, clock: performance.now(),
      extension: mimeType.includes('webm') ? 'webm' : 'ogg', samples: 0, audible: 0
    };
    part.finished = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType })), { once: true });
      recorder.addEventListener('error', () => reject(new Error('录音设备中断，无法封存当前片段')), { once: true });
    });
    part.finished.catch(error => {
      this.pause().catch(() => {});
      this.onError(error);
    });
    recorder.start(15000);
    this.part = part;
    const interval = this.kind === 'desk' ? this.session.interval : 180;
    this.cutTimer = setTimeout(() => {
      const action = this.kind === 'desk' ? this.cut() : this.stop();
      action.catch(() => {});
    }, interval * 1000);
  }

  async seal() {
    clearTimeout(this.cutTimer);
    const part = this.part;
    if (!part) return;
    this.part = null;
    const duration = performance.now() - part.clock;
    this.elapsed += duration;
    if (part.recorder.state !== 'inactive') part.recorder.stop();
    const blob = await part.finished;
    if (!blob.size) return;
    return {
      id: part.id, duration, extension: part.extension,
      quiet: part.samples >= 16 && part.audible === 0, bytes: new Uint8Array(await blob.arrayBuffer())
    };
  }

  async save() {
    while (this.unsaved.length) {
      const clip = await window.desk.put(this.session.id, this.unsaved[0]);
      this.unsaved.shift();
      this.lastClip = clip;
      this.onClip(clip);
    }
  }

  async closePart(keepRecording) {
    const closing = this.seal();
    closing.catch(() => {});
    try {
      if (keepRecording) this.arm();
      const clip = await closing;
      if (clip) this.unsaved.push(clip);
      await this.save();
    } catch (error) {
      const previous = await closing.catch(() => null);
      if (previous && !this.unsaved.some(item => item.id === previous.id) && this.lastClip?.id !== previous.id) this.unsaved.push(previous);
      const next = await this.seal().catch(() => null);
      if (next) this.unsaved.push(next);
      this.releaseMicrophone();
      await window.desk.phase(this.session.id, 'paused');
      this.setState('paused');
      throw error;
    }
  }

  start() {
    return this.run(async () => {
      if (this.session) return;
      this.setState('opening');
      this.elapsed = 0;
      this.lastClip = null;
      try {
        this.session = await window.desk.begin(this.kind);
        await this.openMicrophone();
        this.arm();
        await window.desk.phase(this.session.id, 'recording');
        this.setState('recording');
      } catch (error) {
        await this.seal().catch(() => {});
        this.releaseMicrophone();
        if (this.session) await window.desk.end(this.session.id).catch(() => {});
        this.session = null;
        this.setState('idle');
        throw error;
      }
    });
  }

  cut() {
    return this.run(async () => {
      if (this.phase !== 'recording') return;
      await this.closePart(true);
      return this.lastClip;
    });
  }

  pause() {
    return this.run(async () => {
      if (this.phase !== 'recording') return;
      const saving = this.closePart(false);
      this.releaseMicrophone();
      await saving;
      await window.desk.phase(this.session.id, 'paused');
      this.setState('paused');
    });
  }

  resume() {
    return this.run(async () => {
      if (this.phase !== 'paused') return;
      await this.save();
      await window.desk.phase(this.session.id, 'opening');
      this.setState('opening');
      try {
        await this.openMicrophone();
        this.arm();
        await window.desk.phase(this.session.id, 'recording');
        this.setState('recording');
      } catch (error) {
        await this.seal().catch(() => {});
        this.releaseMicrophone();
        await window.desk.phase(this.session.id, 'paused');
        this.setState('paused');
        throw error;
      }
    });
  }

  stop() {
    return this.run(async () => {
      if (!this.session) return this.lastClip;
      const saving = this.closePart(false);
      this.releaseMicrophone();
      await saving;
      await window.desk.end(this.session.id);
      this.session = null;
      this.setState('idle');
      return this.lastClip;
    });
  }
}

function connectWaveDecoder() {
  window.desk.onDecode(async ({ id, bytes }) => {
    try {
      const context = new OfflineAudioContext(1, 1, 16000);
      const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const samples = decoded.getChannelData(0);
      const files = [];
      const chunkLength = decoded.sampleRate * 120;
      for (let start = 0; start < samples.length; start += chunkLength) {
        const length = Math.min(chunkLength, samples.length - start);
        const wav = new Uint8Array(44 + length * 2);
        const view = new DataView(wav.buffer);
        const string = (offset, value) => wav.set(new TextEncoder().encode(value), offset);
        string(0, 'RIFF');
        view.setUint32(4, wav.length - 8, true);
        string(8, 'WAVE');
        string(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, decoded.sampleRate, true);
        view.setUint32(28, decoded.sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        string(36, 'data');
        view.setUint32(40, length * 2, true);
        for (let index = 0; index < length; index++) {
          const sample = Math.max(-1, Math.min(1, samples[start + index]));
          view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true);
        }
        files.push(wav);
      }
      window.desk.decoded(id, files);
    } catch {
      window.desk.decoded(id, null);
    }
  });
}
