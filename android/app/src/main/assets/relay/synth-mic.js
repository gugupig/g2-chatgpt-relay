// Synthetic microphone for chatgpt.com dictation (experiment 2, extended for
// the end-to-end prototype).
//
// Replaces navigator.mediaDevices.getUserMedia({audio}) with a WebAudio stream.
// Two sources:
//   live  - 16 kHz s16le PCM pushed frame by frame from the G2 glasses through
//           __synthMic.live (relay-main.js drives it); frames that arrive before
//           the page asks for the mic are queued and played first
//   file  - a clip picked in the floating panel, resampled to 16 kHz mono and
//           played in 100 ms frames (the experiment 2 path)
//
// Runs in the page's MAIN world at document_start (see manifest.json), which is
// what WebViewCompat.addDocumentStartJavaScript does on Android. It only logs
// what the page does; it does not hide itself.
(() => {
  if (window.__synthMic) return

  const RATE = 16000
  const FRAME_SAMPLES = 1600 // 100 ms at 16 kHz
  const LEAD_IN_FRAMES = 3 // 300 ms of silence before the clip, so start-of-speech isn't clipped
  const SCHEDULE_AHEAD_S = 0.3
  const LIVE_JITTER_S = 0.15 // live frames are scheduled this far ahead, to absorb network jitter

  const state = {
    enabled: true,
    pcm: null, // Int16Array, 16 kHz mono
    name: null,
    ctx: null,
    sessions: 0,
    events: [],
    live: null, // { queue, stream, next, frames } while a live turn is open
    onStream: null, // callback(kind) when the page gets a synthetic stream
    onTranscribe: null, // callback(status, ms) when the dictation upload answers
  }
  let panel = null // set by mountPanel()

  function log(...args) {
    console.log('%c[synth-mic]', 'color:#0a0;font-weight:bold', ...args)
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    state.events.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
    if (state.events.length > 1000) state.events.shift()
    state.onLog?.(state.events[state.events.length - 1])
    panel?.render()
  }

  function audioContext() {
    state.ctx ??= new AudioContext()
    if (state.ctx.state === 'suspended') state.ctx.resume()
    return state.ctx
  }

  // Browsers keep an AudioContext suspended until the page gets a real user
  // gesture. Live turns start from the glasses, not from a tap on the page, so
  // the first tap anywhere on the page creates and resumes the context.
  addEventListener('pointerdown', () => {
    const ctx = audioContext()
    if (ctx.state !== 'running') ctx.resume().then(() => log(`audio armed (${ctx.state})`))
  }, { capture: true })

  // Live PCM from the glasses. relay-main.js calls begin() before clicking the
  // dictation button, push() for every frame and end() when the user stops.
  function scheduleLive(live, int16) {
    const ctx = state.ctx
    const f32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
    const buf = ctx.createBuffer(1, f32.length, RATE)
    buf.copyToChannel(f32, 0)
    const node = ctx.createBufferSource()
    node.buffer = buf
    node.connect(live.dest)
    live.next = Math.max(live.next, ctx.currentTime + LIVE_JITTER_S)
    node.start(live.next)
    live.next += f32.length / RATE
  }

  const live = {
    begin() {
      state.live = { queue: [], dest: null, stream: null, next: 0, frames: 0, samples: 0 }
      log('live turn: waiting for the page to open the mic')
    },
    push(bytes) {
      const l = state.live
      if (!l) return
      const int16 = new Int16Array(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes)
      l.frames++
      l.samples += int16.length
      if (l.dest) scheduleLive(l, int16)
      else l.queue.push(int16)
    },
    // Resolves once every pushed frame has played into the stream.
    async end() {
      const l = state.live
      if (!l) return
      const left = l.dest ? Math.max(0, l.next - state.ctx.currentTime) : 0
      log(`live turn: ${l.frames} frames (${(l.samples / RATE).toFixed(2)} s) pushed, ${left.toFixed(2)} s still playing`)
      await new Promise(r => setTimeout(r, left * 1000 + 150))
    },
    close() {
      state.live = null
    },
    get active() {
      return !!state.live
    },
  }

  function createLiveStream() {
    const ctx = audioContext()
    const l = state.live
    l.dest = ctx.createMediaStreamDestination()
    l.stream = l.dest.stream
    l.next = ctx.currentTime + LIVE_JITTER_S
    const queued = l.queue.splice(0)
    for (const int16 of queued) scheduleLive(l, int16)
    const session = ++state.sessions
    const track = l.stream.getAudioTracks()[0]
    const realStop = track.stop.bind(track)
    track.stop = () => {
      log(`#${session} live track.stop() called by page`)
      realStop()
    }
    log(`#${session} live stream started, ${queued.length} queued frames flushed, audio context ${ctx.state}`)
    state.onStream?.('live', ctx.state)
    return l.stream
  }

  async function decodeToPcm16k(arrayBuffer) {
    const decoded = await audioContext().decodeAudioData(arrayBuffer)
    // A one-channel OfflineAudioContext downmixes and resamples in one pass.
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE)
    const src = offline.createBufferSource()
    src.buffer = decoded
    src.connect(offline.destination)
    src.start()
    const f32 = (await offline.startRendering()).getChannelData(0)
    const pcm = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return pcm
  }

  async function loadArrayBuffer(arrayBuffer, name) {
    state.pcm = await decodeToPcm16k(arrayBuffer)
    state.name = name
    log(`loaded ${name}: ${(state.pcm.length / RATE).toFixed(2)} s`)
  }

  async function loadUrl(url) {
    const res = await fetch(url)
    await loadArrayBuffer(await res.arrayBuffer(), url)
  }

  // One stream per getUserMedia call. Frames are scheduled back to back on the
  // AudioContext clock; after the clip ends the track keeps sending silence
  // until the page stops it, like a real mic in a quiet room.
  function createStream() {
    const ctx = audioContext()
    const dest = ctx.createMediaStreamDestination()
    const pcm = state.pcm
    const session = ++state.sessions
    const totalFrames = pcm ? Math.ceil(pcm.length / FRAME_SAMPLES) : 0
    let frameIndex = -LEAD_IN_FRAMES
    let next = ctx.currentTime + 0.05
    let announcedEnd = false

    const pump = () => {
      while (next < ctx.currentTime + SCHEDULE_AHEAD_S) {
        const frame = new Float32Array(FRAME_SAMPLES)
        if (pcm && frameIndex >= 0 && frameIndex < totalFrames) {
          const start = frameIndex * FRAME_SAMPLES
          const end = Math.min(start + FRAME_SAMPLES, pcm.length)
          for (let i = start; i < end; i++) frame[i - start] = pcm[i] / 32768
        }
        const buf = ctx.createBuffer(1, FRAME_SAMPLES, RATE)
        buf.copyToChannel(frame, 0)
        const node = ctx.createBufferSource()
        node.buffer = buf
        node.connect(dest)
        node.start(next)
        next += FRAME_SAMPLES / RATE
        frameIndex++
      }
      if (!announcedEnd && frameIndex >= totalFrames) {
        announcedEnd = true
        log(`#${session} clip finished${pcm ? '' : ' (no clip loaded, silence only)'}; stop dictation now`)
      }
    }
    pump()
    const timer = setInterval(pump, 50)

    const track = dest.stream.getAudioTracks()[0]
    const realStop = track.stop.bind(track)
    track.stop = () => {
      clearInterval(timer)
      log(`#${session} track.stop() called by page`)
      realStop()
    }
    log(`#${session} synthetic stream started: ${state.name ?? 'silence'}, track label "${track.label}"`)
    return dest.stream
  }

  const md = navigator.mediaDevices
  const realGetUserMedia = md.getUserMedia.bind(md)
  md.getUserMedia = async constraints => {
    log('getUserMedia', constraints ?? null)
    if (!state.enabled || !constraints?.audio || constraints.video) {
      log('→ passing through to the real device')
      return realGetUserMedia(constraints)
    }
    if (state.live) return createLiveStream()
    state.onStream?.('file', audioContext().state)
    return createStream()
  }

  // Logged only, to see whether the page inspects devices before or after recording.
  const realEnumerate = md.enumerateDevices.bind(md)
  md.enumerateDevices = async () => {
    const devices = await realEnumerate()
    log(`enumerateDevices → ${devices.length} devices`)
    return devices
  }

  const RealMediaRecorder = window.MediaRecorder
  if (RealMediaRecorder) {
    window.MediaRecorder = class extends RealMediaRecorder {
      constructor(stream, options) {
        super(stream, options)
        // mimeType is only settled once recording starts.
        this.addEventListener('start', () => {
          log(`MediaRecorder started, requested ${options?.mimeType ?? '(default)'}, using ${this.mimeType}`)
        }, { once: true })
      }
    }
  }

  // Logs which endpoint the dictation upload goes to and how it answers.
  const AUDIO_URL = /transcri|audio|speech|voice|dictat/i
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const watch = AUDIO_URL.test(url) && method !== 'GET'
    const t0 = performance.now()
    const res = await realFetch(input, init)
    if (watch) {
      const path = new URL(url, location.href).pathname
      log(`fetch ${method} ${path} → ${res.status} in ${Math.round(performance.now() - t0)} ms`)
      state.onTranscribe?.(res.status, Math.round(performance.now() - t0))
    }
    return res
  }

  // Floating panel: pick the clip, toggle the override, see the event log.
  function mountPanel() {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647'
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        .box{font:12px/1.4 ui-monospace,Menlo,monospace;background:#111;color:#ddd;border:1px solid #3a3;
             border-radius:8px;padding:8px;width:340px;box-shadow:0 4px 16px #0008}
        .row{display:flex;gap:8px;align-items:center;margin-bottom:6px}
        b{color:#6f6} pre{margin:0;max-height:160px;overflow:auto;white-space:pre-wrap;color:#aaa}
        button{font:inherit}
      </style>
      <div class="box">
        <div class="row"><b>synth-mic</b><span id="status"></span>
          <button id="hide" style="margin-left:auto">–</button></div>
        <div id="body">
          <div class="row"><input id="file" type="file" accept="audio/*"></div>
          <div class="row"><label><input id="on" type="checkbox" checked> replace microphone</label>
            <button id="copy">copy log</button></div>
          <pre id="log"></pre>
        </div>
      </div>`
    const $ = id => root.getElementById(id)
    $('file').addEventListener('change', async e => {
      const f = e.target.files?.[0]
      if (f) await loadArrayBuffer(await f.arrayBuffer(), f.name).catch(err => log('decode failed', String(err)))
    })
    $('on').addEventListener('change', e => {
      state.enabled = e.target.checked
      log(`override ${state.enabled ? 'on' : 'off'}`)
    })
    $('copy').addEventListener('click', () => navigator.clipboard.writeText(state.events.join('\n')))
    $('hide').addEventListener('click', () => {
      const body = $('body')
      body.hidden = !body.hidden
    })
    document.documentElement.appendChild(host)
    panel = {
      render() {
        $('status').textContent = state.name ? `${state.name} (${(state.pcm.length / RATE).toFixed(1)} s)` : 'no clip loaded'
        $('log').textContent = state.events.slice(-40).join('\n')
      },
    }
    panel.render()
  }
  if (document.documentElement) mountPanel()
  else document.addEventListener('DOMContentLoaded', mountPanel, { once: true })

  // reply-watch.js logs into the same panel through log().
  window.__synthMic = { state, log, loadUrl, loadArrayBuffer, live, audioContext, FRAME_SAMPLES, RATE }
  log('installed')
})()
