// voice_changer.mjs
//
// Realtime RVC voice-conversion layer for Live Call, built on
// w-okada/voice-changer ("VCClient").
//
// WHY THIS FILE EXISTS
// --------------------
// Lucy 2.5 (decart/lucy-2-5/realtime, a video-to-video model) only ever
// produces the live avatar VIDEO. It does not produce a voice. The audio
// that travels out with the Lucy video during a call is the live audio
// paired with the avatar pipeline - i.e. the local microphone track the
// frontend already streams up as the outgoing call audio (channel 0x02 on
// /api/social-call/media, see server.mjs and app.src.js).
//
// This module takes that continuous live stream and runs it through RVC
// (Retrieval-based Voice Conversion) in real time, chunk after chunk, with
// no buffering of sentences and no file round-trips: audio in -> audio out,
// streaming, at call latency.
//
// HOW IT TALKS TO VOICE-CHANGER
// -----------------------------
// Everything below is against voice-changer's own documented interfaces
// (verified by reading the upstream sources at w-okada/voice-changer):
//
//   * Realtime audio: Socket.IO namespace "/test" on the VCClient server.
//     client -> server: emit "request_message" with [timestamp:int,
//                       packed little-endian int16 PCM]
//     server -> client: "response" with [timestamp:int, int16 PCM, perf]
//     (server/sio/MMVC_Namespace.py - `request_message` unpacks with
//      "<%sh", `response` repacks with "<%sh".)
//
//   * Configuration: plain REST on the same port.
//     GET  /info                       -> server state + model slots
//     POST /update_settings (key, val) -> change any setting
//     POST /load_model (slot, isHalf, params=<json>)
//     POST /upload_file (file, filename) / POST /concat_uploaded_file
//     (server/restapi/MMVC_Rest_Fileuploader.py + VoiceChangerManager.py)
//
//   * Launcher: `python3 MMVCServerSIO.py -p <port> --https false
//     --model_dir <dir> ...` (server/MMVCServerSIO.py args, defaults for
//     the pretrain weights). server/voicechanger/start.sh does that.
//
// SETTINGS WE PUSH ON SESSION START
// ---------------------------------
//   inputSampleRate / outputSampleRate = 16000
//     The RVC pipeline in voice-changer resamples everything to 16 kHz
//     internally anyway (RVCr2.inference: resampy.resample(receivedData,
//     inputSampleRate, 16000)), and the outgoing Telegram call audio pipe
//     is 16 kHz mono s16le (see server/tgcalls_bridge/src/main.rs,
//     AudioDescription { sample_rate: 16000, channel_count: 1 }). Running
//     the I/O at 16 kHz therefore removes BOTH resampling steps.
//   crossFadeOverlapSize = 512 (16 kHz samples = 32 ms)
//     VoiceChangerV2 clamps it with min(crossFadeOverlapSize, block_frame)
//     anyway, and the upstream default (4096) is sized for 48 kHz blocks.
//   extraConvertSize = 1024 (64 ms of look-back context)
//     Upstream default is 4096, again sized for 48 kHz input; at 16 kHz it
//     would add a quarter second of extra audio to every inference and
//     dominate the latency budget.
//
// BACKPRESSURE / LATENCY MODEL
// ----------------------------
// Exactly ONE request is in flight at a time. Samples that arrive while a
// request is in flight accumulate and are sent as the next (larger) chunk
// as soon as the previous response lands. That means:
//   * no audio is dropped or duplicated while the converter keeps up, and
//     output stays a continuous stream (never a gap or a repeat),
//   * the effective chunk size adapts itself to however fast this
//     deployment's CPU/GPU actually is,
//   * if it still cannot keep up, the queue is capped (VOICE_CHANGER_MAX_QUEUE_MS)
//     and the OLDEST samples are dropped, which bounds latency at the cost
//     of a tiny time-compression artifact - never a growing delay.
//
// HONEST FALLBACK
// ---------------
// If voice-changer is not running, has no RVC model selected, or stops
// answering, this module does NOT pretend to convert: it forwards the
// original audio unchanged and reports mode:"bypass" (with the error) so
// the UI can say so. A call must never go silent because the converter is
// down.

import { io } from 'socket.io-client';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function intFromEnv(name, fallback) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}
function floatFromEnv(name, fallback) {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}
function strFromEnv(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const VC_CONFIG = {
  // Where the w-okada/voice-changer server is listening. Default is the
  // upstream port, on the same host as this Node process.
  url: strFromEnv('VOICE_CHANGER_URL', 'http://127.0.0.1:18888').replace(/\/+$/, ''),
  // I/O sample rate for the conversion stream (see header comment).
  sampleRate: intFromEnv('VOICE_CHANGER_SAMPLE_RATE', 16000),
  // Target chunk size, in milliseconds, for each conversion request.
  chunkMs: intFromEnv('VOICE_CHANGER_CHUNK_MS', 32),
  // Cap on how much un-converted audio may be queued before we start
  // dropping the oldest samples to keep latency bounded.
  maxQueueMs: intFromEnv('VOICE_CHANGER_MAX_QUEUE_MS', 240),
  // VoiceChangerV2 / RVC settings (see header comment).
  crossFadeSamples: intFromEnv('VOICE_CHANGER_CROSSFADE_SAMPLES', 512),
  extraConvertSamples: intFromEnv('VOICE_CHANGER_EXTRA_SAMPLES', 1024),
  // -1 = "no model chosen yet" (voice-changer's own empty-slot value).
  modelSlot: intFromEnv('VOICE_CHANGER_MODEL_SLOT', -1),
  // Optional overrides. Left unset => the model's own slot defaults are
  // used (RVCr2.initialize() copies defaultTune/defaultIndexRatio/
  // defaultProtect out of the model slot).
  tran: process.env.VOICE_CHANGER_TRAN !== undefined && process.env.VOICE_CHANGER_TRAN !== ''
    ? intFromEnv('VOICE_CHANGER_TRAN', 0) : null,
  indexRatio: process.env.VOICE_CHANGER_INDEX_RATIO !== undefined && process.env.VOICE_CHANGER_INDEX_RATIO !== ''
    ? floatFromEnv('VOICE_CHANGER_INDEX_RATIO', 0) : null,
  protect: process.env.VOICE_CHANGER_PROTECT !== undefined && process.env.VOICE_CHANGER_PROTECT !== ''
    ? floatFromEnv('VOICE_CHANGER_PROTECT', 0.5) : null,
  f0Detector: strFromEnv('VOICE_CHANGER_F0_DETECTOR', ''),
  // If voice-changer does not answer within this long, stop waiting on it
  // and fall back to pass-through until it recovers.
  responseTimeoutMs: intFromEnv('VOICE_CHANGER_TIMEOUT_MS', 5000),
  // Opt-in: let this process launch voice-changer itself. Off by default -
  // it is a heavyweight Python service and most deployments will run it
  // separately (or on another host entirely) via VOICE_CHANGER_URL.
  autostart: /^(1|true|yes)$/i.test(strFromEnv('VOICE_CHANGER_AUTOSTART', '')),
};

const EMPTY = new Int16Array(0);

// Socket.IO hands binary payloads back as a Buffer that is very often a view
// into a larger pooled allocation, so its byteOffset is not guaranteed to be
// even - and an Int16Array view requires one. Read it sample by sample
// instead of failing on odd offsets (same reason as server.mjs's
// vcSamplesFrom for the inbound direction).
function int16FromBytes(bin) {
  if (!bin || bin.length < 2) return EMPTY;
  const bytes = Buffer.isBuffer(bin)
    ? bin
    : Buffer.from(bin.buffer ?? bin, bin.byteOffset ?? 0, bin.byteLength ?? bin.length);
  const n = Math.floor(bytes.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

class RealtimeVoiceChanger {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.session = null;       // { platform, onConverted, startedAt }
    this.connected = false;
    this.ready = false;        // socket up AND a conversion configured
    this.mode = 'off';         // 'off' | 'convert' | 'bypass'
    this.lastError = null;

    // Streaming state - see the backpressure note in the header comment.
    this._pending = [];
    this._pendingSamples = 0;
    this._inFlight = false;
    this._inFlightTs = 0;
    this._watchdog = null;
    this._tsSeq = 0;

    this.stats = {
      chunks: 0,          // conversion requests completed
      bypassedChunks: 0,  // chunks forwarded unconverted (converter down)
      droppedSamples: 0,  // samples discarded to keep latency bounded
      rttMs: 0,           // last request->response round trip
      inferenceMs: 0,     // last reported conversion time (perf[1])
      queuedSamples: 0,
    };

    this._appliedSignature = '';
  }

  // ------------------------------------------------------------------ //
  // REST helpers (voice-changer's FastAPI side, same port as Socket.IO) //
  // ------------------------------------------------------------------ //

  async _get(endpoint) {
    const res = await fetch(`${this.config.url}${endpoint}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`voice-changer ${endpoint} returned HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async _postForm(endpoint, fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      body.append(k, String(v));
    }
    const res = await fetch(`${this.config.url}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`voice-changer ${endpoint} returned HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  async getInfo() {
    return this._get('/info');
  }

  async listModels() {
    // Nothing else connects until a call starts, so a voice-changer that came
    // up after this backend booted would otherwise still report "offline"
    // forever. A short wait is enough here: the list is only read when the
    // call screen opens, not on a hot path.
    if (!this.socket) this.connect();
    if (!this.connected) await this._waitForSocket(1500);
    const info = await this.getInfo();
    const slots = Array.isArray(info?.modelSlots) ? info.modelSlots : [];
    return slots
      .map((slot, index) => ({
        slot: slot?.slotIndex ?? index,
        name: slot?.name || (slot?.modelFile ? String(slot.modelFile) : `Slot ${index}`),
        voiceChangerType: slot?.voiceChangerType || '',
        modelFile: slot?.modelFile || '',
        indexFile: slot?.indexFile || '',
        samplingRate: slot?.samplingRate || 0,
        f0: slot?.f0 !== undefined ? !!slot.f0 : null,
        embedder: slot?.embedder || '',
        isONNX: !!slot?.isONNX,
        // A slot with no model file is an empty slot - not selectable.
        available: !!slot?.modelFile,
      }))
      // RVC only: the requirement is RVC voice conversion, so a slot holding
      // some other model type is not an option here (and selecting it would
      // silently convert with something else).
      .filter((m) => m.available && (m.voiceChangerType === 'RVC' || m.voiceChangerType === ''));
  }

  async updateSetting(key, val) {
    return this._postForm('/update_settings', { key, val });
  }

  async selectModel(slotIndex) {
    // Keep our own record in sync: every other part of this module (and the
    // status the app renders) reads config.modelSlot, not voice-changer.
    this.config.modelSlot = Number(slotIndex);
    const info = await this.updateSetting('modelSlotIndex', this.config.modelSlot);
    this._appliedSignature = ''; // force the per-session settings to re-apply
    await this.ensureReady();
    return info;
  }

  /**
   * Loads an RVC model that already exists on this host into a
   * voice-changer model slot, using voice-changer's own upload flow:
   *   /upload_file (chunked) -> /concat_uploaded_file -> /load_model
   * `pthPath` is the RVC .pth (or .onnx) checkpoint; `indexPath` is the
   * optional FAISS .index (kind "rvcIndex").
   */
  async loadModel({ slot, pthPath, indexPath }) {
    if (!pthPath) throw new Error('pthPath is required');
    if (!fs.existsSync(pthPath)) throw new Error(`model file not found: ${pthPath}`);
    if (indexPath && !fs.existsSync(indexPath)) throw new Error(`index file not found: ${indexPath}`);
    if (!Number.isInteger(slot) || slot < 0) throw new Error('slot must be a non-negative integer');

    const dir = `live-call-${Date.now()}`;
    const uploads = [];
    for (const filePath of [pthPath, indexPath].filter(Boolean)) {
      uploads.push(await this._uploadFile(filePath, dir));
    }

    const files = [
      { name: path.basename(pthPath), kind: 'rvcModel', dir },
    ];
    if (indexPath) files.push({ name: path.basename(indexPath), kind: 'rvcIndex', dir });

    // `params` is a JSON string: voice-changer's LoadModelParams dataclass.
    const params = {
      voiceChangerType: 'RVC',
      slot,
      isSampleMode: false,
      sampleId: '',
      files,
      params: {},
    };
    const res = await this._postForm('/load_model', { slot, isHalf: false, params: JSON.stringify(params) });
    this._appliedSignature = '';
    return { status: 'loaded', slot, uploaded: uploads, response: res };
  }

  async _uploadFile(filePath, dir, chunkSize = 4 * 1024 * 1024) {
    const name = path.basename(filePath);
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    try {
      let chunkIndex = 0;
      let offset = 0;
      while (offset < size) {
        const length = Math.min(chunkSize, size - offset);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, offset);
        offset += length;
        // Multipart: field "file" (the bytes) + field "filename" (chunk name).
        const form = new FormData();
        form.append('file', new Blob([buf]), `${name}.chunk${chunkIndex}`);
        form.append('filename', `${name}.chunk${chunkIndex}`);
        const res = await fetch(`${this.config.url}/upload_file`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`upload_file failed for ${name} chunk ${chunkIndex} (HTTP ${res.status})`);
        chunkIndex++;
      }
      // Reassemble the chunks inside voice-changer's upload dir.
      const res = await this._postForm('/concat_uploaded_file', {
        filename: name,
        filenameChunkNum: chunkIndex,
      });
      return { name, chunks: chunkIndex, bytes: size, response: res };
    } finally {
      fs.closeSync(fd);
    }
  }

  // ------------------------------------------------------------------ //
  // Socket.IO streaming                                                 //
  // ------------------------------------------------------------------ //

  connect() {
    if (this.socket) return this.socket;
    // Namespace "/test" is where voice-changer registers MMVC_Namespace.
    const socket = io(`${this.config.url}/test`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 5000,
    });
    socket.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      console.log(`[VoiceChanger] connected to ${this.config.url}/test`);
      // Re-applying settings is cheap and covers a voice-changer restart
      // (a fresh process comes back with its own defaults).
      this._appliedSignature = '';
      this.ensureReady().catch((e) => {
        this.lastError = e.message;
        console.warn('[VoiceChanger] post-connect setup failed:', e.message);
      });
    });
    socket.on('connect_error', (err) => {
      this.connected = false;
      this.ready = false;
      this.lastError = `voice-changer unreachable at ${this.config.url} (${err?.message || err})`;
      this._degrade();
    });
    socket.on('disconnect', (reason) => {
      this.connected = false;
      this.ready = false;
      this.lastError = `voice-changer disconnected (${reason})`;
      this._degrade();
    });
    socket.on('response', (msg) => this._onResponse(msg));
    this.socket = socket;
    return socket;
  }

  _onResponse(msg) {
    if (!Array.isArray(msg)) return;
    const [ts, bin, perf] = msg;
    if (this._inFlight && Number(ts) !== this._inFlightTs) return; // stale/duplicate
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    this._inFlight = false;

    if (this._inFlightAt) {
      const rtt = Date.now() - this._inFlightAt;
      // Smoothed: a single outlier is noise, a trend is what we surface.
      this.stats.rttMs = this.stats.rttMs ? Math.round(this.stats.rttMs * 0.8 + rtt * 0.2) : rtt;
    }
    if (Array.isArray(perf) && perf.length >= 2) {
      // perf = [preprocess, mainprocess, postprocess] in SECONDS.
      const main = Number(perf[1]) || 0;
      this.stats.inferenceMs = Math.round(main * 1000);
    }
    this.stats.chunks++;

    this._emitConverted(int16FromBytes(bin));
    this._pump();
  }

  _emitConverted(samples) {
    const session = this.session;
    if (!session) return;
    try {
      session.onConverted(samples);
    } catch (e) {
      console.warn('[VoiceChanger] onConverted handler threw:', e.message);
    }
  }

  _degrade() {
    this.ready = false;
    this.mode = 'bypass';
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    this._inFlight = false;
    // Flush whatever was queued straight through, so the call's audio
    // never stalls while the converter is down.
    if (this._pending.length) {
      const chunks = this._pending;
      this._pending = [];
      this._pendingSamples = 0;
      for (const chunk of chunks) {
        this.stats.bypassedChunks++;
        this._emitConverted(chunk);
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Session lifecycle                                                   //
  // ------------------------------------------------------------------ //

  /**
   * Starts a conversion session.
   * @param {object} opts
   * @param {string} opts.platform  'whatsapp' | 'telegram' - only affects reporting
   * @param {(samples: Int16Array) => void} opts.onConverted  called, in order,
   *        with every converted PCM chunk (16 kHz mono int16). Called with
   *        the ORIGINAL audio when running in bypass mode.
   */
  async startSession({ platform, onConverted }) {
    this.stopSession(false);
    this.session = {
      platform: platform || null,
      onConverted: typeof onConverted === 'function' ? onConverted : () => {},
      startedAt: Date.now(),
    };
    this.mode = 'bypass'; // until the converter proves it is actually ready
    this.connect();
    try {
      await this.ensureReady();
    } catch (e) {
      // The session still exists: audio keeps flowing, unconverted. Not
      // throwing here matters - a call that is already ringing must not
      // fail (or go silent) because the converter is unreachable.
      this.ready = false;
      this.mode = 'bypass';
      this.lastError = e.message;
      console.warn('[VoiceChanger] not converting - ' + e.message);
    }
    return this.status();
  }

  stopSession(reportMode = true) {
    this.session = null;
    this._pending = [];
    this._pendingSamples = 0;
    this._inFlight = false;
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    if (reportMode) this.mode = 'off';
  }

  /**
   * Pushes one chunk of live outgoing call audio (16 kHz mono int16) into
   * the converter. Converted audio comes back through onConverted, in
   * order, as fast as the model can produce it.
   */
  push(samples) {
    if (!this.session) return;
    if (!this.ready || !this.socket || !this.connected) {
      // Converter down / not configured: forward untouched, never stall.
      this.stats.bypassedChunks++;
      this._emitConverted(samples);
      return;
    }

    this._pending.push(samples);
    this._pendingSamples += samples.length;

    // Bound the queue: drop the OLDEST audio so added latency can never
    // run away (see the backpressure note in the header comment).
    const maxSamples = Math.max(1, Math.round((this.config.maxQueueMs / 1000) * this.config.sampleRate));
    while (this._pendingSamples > maxSamples && this._pending.length) {
      const head = this._pending[0];
      if (head.length <= this._pendingSamples - maxSamples) {
        this._pending.shift();
        this._pendingSamples -= head.length;
        this.stats.droppedSamples += head.length;
      } else {
        const drop = this._pendingSamples - maxSamples;
        this._pending[0] = head.subarray(drop);
        this._pendingSamples -= drop;
        this.stats.droppedSamples += drop;
      }
    }
    this.stats.queuedSamples = this._pendingSamples;
    this._pump();
  }

  _pump() {
    if (!this.session || this._inFlight || !this.ready || !this.socket || !this.connected) return;
    if (this._pendingSamples === 0) return;

    const maxChunk = Math.max(160, Math.round((this.config.chunkMs / 1000) * this.config.sampleRate));
    let take = Math.min(maxChunk, this._pendingSamples);
    // RVC works on 160-sample (10 ms) feature hops; keeping chunks a whole
    // multiple avoids ragged buffers upstream.
    take = Math.max(160, Math.floor(take / 160) * 160);
    take = Math.min(take, this._pendingSamples);

    const out = new Int16Array(take);
    let written = 0;
    while (written < take && this._pending.length) {
      const head = this._pending[0];
      const need = take - written;
      if (head.length <= need) {
        out.set(head, written);
        written += head.length;
        this._pending.shift();
      } else {
        out.set(head.subarray(0, need), written);
        this._pending[0] = head.subarray(need);
        written += need;
      }
    }
    this._pendingSamples -= written;
    this.stats.queuedSamples = this._pendingSamples;

    const ts = ++this._tsSeq;
    this._inFlight = true;
    this._inFlightTs = ts;
    this._inFlightAt = Date.now();
    this.socket.emit('request_message', [ts, Buffer.from(out.buffer, out.byteOffset, out.byteLength)]);

    if (this._watchdog) clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (!this._inFlight) return;
      // voice-changer stopped answering mid-call. Drop to bypass instead
      // of freezing the outgoing audio.
      this._inFlight = false;
      this.ready = false;
      this.lastError = `voice-changer did not respond within ${this.config.responseTimeoutMs}ms`;
      console.warn('[VoiceChanger] ' + this.lastError);
      this._degrade();
    }, this.config.responseTimeoutMs);
  }

  // ------------------------------------------------------------------ //
  // Configuration / status                                              //
  // ------------------------------------------------------------------ //

  /**
   * Makes sure voice-changer is configured for 16 kHz streaming RVC and
   * that the chosen model slot is loaded. Safe to call repeatedly; it
   * re-applies only when the configuration actually changed.
   */
  async ensureReady() {
    if (!this.socket || !this.connected) {
      if (!this.socket) this.connect();
      await this._waitForSocket(4000);
    }
    if (!this.connected) throw new Error(this.lastError || 'voice-changer not connected');

    const signature = JSON.stringify([
      this.config.sampleRate,
      this.config.crossFadeSamples,
      this.config.extraConvertSamples,
      this.config.modelSlot,
      this.config.tran,
      this.config.indexRatio,
      this.config.protect,
      this.config.f0Detector,
    ]);
    if (signature === this._appliedSignature && this.ready) {
      this._setModeFromConfig();
      return true;
    }

    // No model slot chosen -> configure voice-changer's own pass-through so
    // audio is returned untouched rather than zeroed (VoiceChangerManager.
    // changeVoice() returns the input as-is when passThrough is true).
    await this.updateSetting('passThrough', this.config.modelSlot < 0 ? 'true' : 'false');

    if (this.config.modelSlot >= 0) {
      await this.updateSetting('modelSlotIndex', this.config.modelSlot);
      // These must follow the slot selection: selecting a slot rebuilds the
      // voice changer (generateVoiceChanger) and re-applies only the
      // settings voice-changer has persisted itself.
      if (this.config.tran !== null) await this.updateSetting('tran', this.config.tran);
      if (this.config.indexRatio !== null) await this.updateSetting('indexRatio', this.config.indexRatio);
      if (this.config.protect !== null) await this.updateSetting('protect', this.config.protect);
      if (this.config.f0Detector) await this.updateSetting('f0Detector', this.config.f0Detector);
      await this.updateSetting('extraConvertSize', this.config.extraConvertSamples);
    }

    // VoiceChangerV2 settings (I/O rate + crossfade) apply regardless.
    await this.updateSetting('inputSampleRate', this.config.sampleRate);
    await this.updateSetting('outputSampleRate', this.config.sampleRate);
    await this.updateSetting('crossFadeOverlapSize', this.config.crossFadeSamples);

    this._appliedSignature = signature;
    this._setModeFromConfig();
    return true;
  }

  // 'convert' only when a model slot is actually selected - otherwise
  // voice-changer is in pass-through and reporting anything else would claim
  // a conversion that is not happening.
  _setModeFromConfig(){
    this.ready = true;
    this.mode = this.config.modelSlot >= 0 ? 'convert' : 'bypass';
    this.lastError = this.config.modelSlot < 0
      ? 'No RVC model slot selected on the voice-changer server'
      : null;
  }

  async _waitForSocket(timeoutMs) {
    if (this.connected) return true;
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.socket?.off('connect', done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.socket?.once('connect', done);
    });
    return this.connected;
  }

  getStats() {
    return {
      ...this.stats,
      queuedMs: Math.round((this.stats.queuedSamples / this.config.sampleRate) * 1000),
    };
  }

  status() {
    return {
      configured: true,
      url: this.config.url,
      sampleRate: this.config.sampleRate,
      connected: this.connected,
      ready: this.ready,
      // 'off' when nothing is converting (no session), 'convert' while audio
      // really is going through the model, 'bypass' while a session is up but
      // the converter is not usable - the app shows the difference.
      mode: this.session ? this.mode : 'off',
      modelSlot: this.config.modelSlot,
      active: !!this.session,
      platform: this.session?.platform || null,
      sessionStartedAt: this.session?.startedAt || null,
      error: this.lastError,
      stats: this.getStats(),
      settings: {
        tran: this.config.tran,
        indexRatio: this.config.indexRatio,
        protect: this.config.protect,
        f0Detector: this.config.f0Detector,
        chunkMs: this.config.chunkMs,
        maxQueueMs: this.config.maxQueueMs,
      },
    };
  }
}

export const voiceChanger = new RealtimeVoiceChanger(VC_CONFIG);

// --------------------------------------------------------------------- //
// Optional: let this process own the voice-changer server's lifecycle.   //
// Off by default (VOICE_CHANGER_AUTOSTART) - it is a big Python service  //
// and is usually better run separately / on its own host.                //
// --------------------------------------------------------------------- //
let vcProcess = null;

export function startVoiceChangerProcess() {
  if (!VC_CONFIG.autostart) {
    console.log('[VoiceChanger] VOICE_CHANGER_AUTOSTART is off - expecting voice-changer at ' + VC_CONFIG.url);
    return;
  }
  const script = path.join(__dirname, 'voicechanger', 'start.sh');
  if (!fs.existsSync(script)) {
    console.warn('[VoiceChanger] autostart requested but server/voicechanger/start.sh is missing - skipping.');
    return;
  }
  console.log('[VoiceChanger] Launching w-okada/voice-changer (RVC) server...');
  vcProcess = spawn('bash', [script], {
    env: { ...process.env, VOICE_CHANGER_PORT: String(new URL(VC_CONFIG.url).port || 18888) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vcProcess.stdout.on('data', (d) => console.log(`[VoiceChanger] ${d.toString().trim()}`));
  vcProcess.stderr.on('data', (d) => console.error(`[VoiceChanger] ${d.toString().trim()}`));
  vcProcess.on('exit', (code) => {
    console.warn(`[VoiceChanger] Server exited with code ${code}, restarting in 10s...`);
    vcProcess = null;
    setTimeout(startVoiceChangerProcess, 10000);
  });
}

export function stopVoiceChangerProcess() {
  if (vcProcess) { try { vcProcess.kill('SIGTERM'); } catch (e) {} vcProcess = null; }
}
