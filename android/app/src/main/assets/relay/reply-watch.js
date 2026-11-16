// Experiment 3: can the reply be read reliably, and when is it finished?
//
// Watches chatgpt.com passively. For each turn it streams the last assistant
// message's text from the DOM and timestamps the "finished" signals:
//   complete - the turn's data-talvt-turn-state attribute becomes "complete"
//   stop     - the stop-generating button goes away
//   actions  - the turn's copy button appears
//   stable   - the text has not changed for STABLE_MS
//   sse      - the page's own /backend-api/.../conversation response stream ends
// It also logs every turn-state value and every button label that appears or
// disappears during the turn, so the stop button's label can be learned.
// It also rebuilds the reply text from that stream as a cross-check. It never
// types, clicks or sends anything; you send messages by hand.
//
// Loaded after synth-mic.js and logs into its panel. Selectors live in one
// object so a changed chatgpt.com front end can be patched in one place.
(() => {
  if (window.__replyWatch) return

  // First selectors in each list: chatgpt.com as of 2026-11-07 (no data-testid
  // left). Button labels follow the UI language, so English and Chinese are both
  // listed; the turn-state attribute doesn't, which is why it decides "done".
  // The last selector in each list is the older layout, kept for the mock.
  const SEL = {
    assistant: '[data-content-search-unit-key$=":assistant"], [data-message-author-role="assistant"]',
    assistantText: '[data-markdown-text-style="assistant-message"], .markdown',
    user: '[data-content-search-unit-key$=":user"], [data-message-author-role="user"]',
    turnState: '[data-talvt-turn-state]',
    stop: 'button[aria-label^="Stop"], button[aria-label="停止"], [data-testid="stop-button"]',
    copy: 'button[aria-label="Copy"], button[aria-label="复制"], [data-testid="copy-turn-action-button"]',
    turn: '[data-turn-key], article, [data-testid^="conversation-turn"]',
  }
  const SSE_SAMPLE = 40 // raw events kept per turn, for learning the stream format
  const COMPLETE_GRACE_MS = 300 // let the last DOM update land after turn-state flips
  const opts = { logButtons: false } // __replyWatch.opts.logButtons = true to log every button label change
  // relay-main.js sets these to forward the reply to the glasses.
  const hooks = { onStart: null, onUpdate: null, onDone: null }
  const STABLE_MS = 1500
  const POLL_MS = 100
  const CONVERSATION_URL = /\/backend-api\/(f\/)?conversation(\?|$)/

  const log = (...a) => (window.__synthMic?.log ?? console.log)('[reply]', ...a)
  const utf8Bytes = s => new TextEncoder().encode(s).length
  const now = () => performance.now()

  const turns = []
  let turn = null // the turn being watched
  let armed = null // assistant elements present just before relay-main.js clicked send

  // The reply is the last assistant element that wasn't on the page when the
  // turn started (element identity, since a new chat re-renders the list).
  // Fallback: a page may add the empty reply element in the same render as the
  // stop button, before the turn opens; an in-progress last message is the reply.
  function replyElement(t) {
    const all = [...document.querySelectorAll(SEL.assistant)]
    for (let i = all.length - 1; i >= 0; i--) if (!t.existing.has(all[i])) return all[i]
    const last = all[all.length - 1]
    const state = last?.closest(SEL.turnState)?.dataset.talvtTurnState ?? last?.querySelector(SEL.turnState)?.dataset.talvtTurnState
    return state === 'in_progress' ? last : null
  }
  const textOf = el => (el.querySelector(SEL.assistantText) ?? el).innerText.trim()
  const buttonLabels = () => new Set([...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')))

  function startTurn(reason) {
    if (turn && !turn.done) finishTurn('superseded')
    turn = {
      n: turns.length + 1,
      reason,
      t0: now(),
      existing: armed ?? new Set(document.querySelectorAll(SEL.assistant)),
      el: null,
      text: '',
      firstTextAt: null,
      lastChangeAt: null,
      updates: 0,
      signals: {},
      sseText: null,
      sseEvents: 0,
      requests: 0,
      lastBeat: now(),
      labels: buttonLabels(),
      state: null,
      sseSample: [],
      done: false,
    }
    armed = null
    turns.push(turn)
    log(`#${turn.n} turn started (${reason})`)
    hooks.onStart?.(turn)
  }

  function mark(signal) {
    if (!turn || turn.signals[signal] != null) return
    turn.signals[signal] = Math.round(now() - turn.t0)
    log(`#${turn.n} signal ${signal} at ${turn.signals[signal]} ms, text ${turn.text.length} chars`)
  }

  // turn-state "complete" ends the turn on its own; stop/actions/sse are
  // only logged for comparison. Pages without turn-state (the mock) fall back
  // to stop + actions; anything else times out 10 s after the text settles.
  function checkDone() {
    const s = turn.signals
    if (s.complete != null) {
      if (now() - turn.lastChangeAt >= COMPLETE_GRACE_MS) finishTurn('complete')
      return
    }
    // The stop button went away and no text ever came (an error, or a reply
    // the selectors can't read): end the turn rather than wait forever.
    if (s.stop != null && !turn.text && now() - turn.t0 - s.stop > 15000) return finishTurn('stopped without text')
    if (s.stable == null) return
    const sinceStable = now() - turn.t0 - s.stable
    if (turn.state == null && s.stop != null && s.actions != null && (s.sse != null || sinceStable > 3000)) finishTurn('stop+actions')
    else if (sinceStable > 10000) finishTurn('timeout, missing ' + ['complete', 'stop', 'actions'].filter(k => s[k] == null).join('+'))
  }

  function finishTurn(reason) {
    if (!turn || turn.done) return
    turn.done = true
    const t = turn
    const sseMatch = t.sseText == null ? 'n/a' : t.sseText.trim() === t.text ? 'exact' : `differs (sse ${t.sseText.trim().length} chars)`
    log(
      `#${t.n} DONE (${reason}): ${t.text.length} chars / ${utf8Bytes(t.text)} UTF-8 bytes, ` +
        `${t.updates} DOM updates, first text ${t.firstTextAt ?? '-'} ms, ` +
        `signals ${JSON.stringify(t.signals)}, sse events ${t.sseEvents}, sse text ${sseMatch}`,
    )
    log(`#${t.n} text: ${t.text.slice(0, 120).replace(/\n/g, '⏎')}${t.text.length > 120 ? '…' : ''}`)
    hooks.onDone?.(t, reason)
  }

  const selectorCounts = () => Object.fromEntries(Object.entries(SEL).map(([k, q]) => [k, document.querySelectorAll(q).length]))

  // Polling is simpler and more robust than reasoning about which mutation
  // touched what; 100 ms is well under the glasses' useful refresh rate.
  const seenErrors = new Set()
  function safePoll() {
    try {
      poll()
    } catch (err) {
      const msg = String(err?.stack ?? err).split('\n').slice(0, 2).join(' | ')
      if (!seenErrors.has(msg)) {
        seenErrors.add(msg)
        log(`poll error: ${msg}`)
      }
    }
  }

  function poll() {
    // Turns open on the stop button or the conversation request, not on new
    // user bubbles: an existing chat renders its old bubbles after page load.
    // Not dictation's "Stop dictation", which the English stop selector also matches.
    const stopVisible = [...document.querySelectorAll(SEL.stop)].some(b => !/dictation|听写/i.test(b.getAttribute('aria-label') ?? ''))
    if (stopVisible && (!turn || turn.done)) startTurn('stop button appeared')
    if (!turn || turn.done) return

    // Read the text before checking signals, so each signal logs the text it saw.
    const el = replyElement(turn)
    if (el) {
      turn.el = el
      const text = textOf(el)
      if (text !== turn.text) {
        turn.text = text
        turn.updates++
        turn.lastChangeAt = now()
        turn.firstTextAt ??= Math.round(now() - turn.t0)
        delete turn.signals.stable // text moved again
        hooks.onUpdate?.(turn)
      } else if (turn.text && now() - turn.lastChangeAt >= STABLE_MS) {
        mark('stable')
      }
      const article = el.closest(SEL.turn) ?? el.parentElement
      if (article?.querySelector(SEL.copy)) mark('actions')
      const state = (el.closest(SEL.turnState) ?? article?.querySelector(SEL.turnState))?.dataset.talvtTurnState ?? null
      if (state !== turn.state) {
        log(`#${turn.n} turn-state ${turn.state ?? '(none)'} → ${state ?? '(none)'} at ${Math.round(now() - turn.t0)} ms`)
        turn.state = state
      }
      if (state === 'complete' && turn.text) mark('complete')
    }
    if (opts.logButtons) {
      const labels = buttonLabels()
      const added = [...labels].filter(l => !turn.labels.has(l))
      const removed = [...turn.labels].filter(l => !labels.has(l))
      if (added.length || removed.length) {
        log(`#${turn.n} buttons at ${Math.round(now() - turn.t0)} ms: +${JSON.stringify(added)} -${JSON.stringify(removed)}`)
      }
      turn.labels = labels
    }
    if (stopVisible) turn.sawStop = true
    else if (turn.sawStop) mark('stop')
    // While a turn is open, say every 3 s what the selectors see, so a changed
    // page structure shows up in the log instead of as silence.
    if (now() - turn.lastBeat > 3000) {
      turn.lastBeat = now()
      log(`#${turn.n} waiting ${Math.round((now() - turn.t0) / 1000)} s: ${JSON.stringify(selectorCounts())}, reply ${el ? `${turn.text.length} chars` : 'not found'}`)
    }
    checkDone()
  }

  // Passive copy of the page's own response stream (Response.clone()).
  // Format seen on 2026-11-07 ("v1" delta encoding, undocumented): each event
  // is an op {p, o, v}; a missing p or o repeats the previous event's; o
  // "patch" (or a bare array v) holds a list of ops; a whole message arrives as
  // {v: {message}} or {p: "", o: "add", v: {message}}. Only appends to
  // /message/content/parts/N of an assistant text message are reply text;
  // metadata paths such as model_dil_v2/fallbackMarkdown repeat the same text.
  async function readSse(res, t) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let text = ''
    let lastP = null
    let lastO = null
    const PART = /^\/message\/content\/parts\/\d+$/
    const takeMessage = m => {
      if (m?.author?.role === 'assistant' && m.content?.content_type === 'text' && Array.isArray(m.content.parts)) {
        text = m.content.parts.filter(x => typeof x === 'string').join('')
      }
    }
    // A patch container (o "patch", or a bare array v) doesn't change the
    // inherited p/o; the ops inside it do.
    const takeOp = op => {
      if (op == null || typeof op !== 'object') return
      if (Array.isArray(op.v) && (op.o === 'patch' || op.o == null)) return op.v.forEach(takeOp)
      const p = op.p ?? lastP
      const o = op.o ?? lastO
      lastP = p
      lastO = o
      if (op.v?.message) takeMessage(op.v.message)
      else if (o === 'append' && typeof op.v === 'string' && PART.test(p ?? '')) text += op.v
    }
    const take = obj => (obj?.message ? takeMessage(obj.message) : takeOp(obj))
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (err) {
        // chatgpt.com aborts the request itself once it has the whole reply.
        if (err?.name !== 'AbortError') throw err
        t.sseEnd = 'aborted by page'
        break
      }
      const { value, done } = chunk
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          t.sseEvents++
          if (t.sseSample.length < SSE_SAMPLE) t.sseSample.push(data.slice(0, 300))
          if (data === '[DONE]') continue
          try {
            take(JSON.parse(data))
          } catch {
            // non-JSON keepalive or unknown event
          }
        }
      }
    }
    t.sseEnd ??= 'closed'
    t.sseText = text
  }

  const realFetch = window.fetch
  window.fetch = async function (input, init) {
    const res = await realFetch.call(this, input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method === 'POST' && CONVERSATION_URL.test(new URL(url, location.href).pathname + '?')) {
        // A second request on an open turn means the page moved on without us
        // seeing the first turn finish; start a fresh one.
        if (!turn || turn.done || turn.requests > 0) startTurn('conversation request')
        const t = turn
        t.requests++
        log(`#${t.n} conversation stream ${res.status} ${res.headers.get('content-type') ?? ''}`)
        if (res.body && /event-stream/.test(res.headers.get('content-type') ?? '')) {
          readSse(res.clone(), t)
            .then(() => {
              log(`#${t.n} stream ${t.sseEnd}: ${t.sseEvents} events, rebuilt ${t.sseText.length} chars: ${t.sseText.slice(0, 60).replace(/\n/g, '⏎')}`)
              if (turn === t) mark('sse')
            })
            .catch(err => log(`#${t.n} sse read failed: ${err}`))
        }
      }
    } catch (err) {
      log(`fetch tap error: ${err}`)
    }
    return res
  }

  function start() {
    setInterval(safePoll, POLL_MS)
    log(`watching; ${document.querySelectorAll(SEL.user).length} user / ${document.querySelectorAll(SEL.assistant).length} assistant messages on page`)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  // Console helpers for when the selectors stop matching:
  //   __replyWatch.diagnose()          what the page exposes (testids, roles, button labels)
  //   __replyWatch.locate('some words') the attributes around the element showing that text
  function describe(el) {
    const attrs = [...el.attributes]
      .filter(a => a.name.startsWith('data-') || ['id', 'role', 'aria-label'].includes(a.name))
      .map(a => `${a.name}="${a.value.slice(0, 40)}"`)
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${attrs.join(' ')}>`
  }

  function diagnose() {
    const counts = selectorCounts()
    const testids = {}
    for (const e of document.querySelectorAll('[data-testid]')) {
      const id = e.dataset.testid.replace(/\d+/g, 'N')
      testids[id] = (testids[id] ?? 0) + 1
    }
    const dataAttrs = new Set()
    for (const e of document.querySelectorAll('main *')) for (const a of e.attributes) if (a.name.startsWith('data-')) dataAttrs.add(a.name)
    const buttons = [...document.querySelectorAll('button[aria-label], button[data-testid]')]
      .map(b => `${b.dataset.testid ?? '-'} | ${b.getAttribute('aria-label') ?? '-'}`)
    log('diagnose selector counts', counts)
    log('diagnose data-testid (digits→N)', testids)
    log('diagnose data-* attribute names in <main>', [...dataAttrs])
    log('diagnose buttons (testid | aria-label)', [...new Set(buttons)].slice(0, 50))
    return { counts, testids, dataAttrs: [...dataAttrs], buttons }
  }

  function locate(snippet) {
    const hits = [...document.querySelectorAll('main *')].filter(e => e.innerText?.includes(snippet))
    // Deepest match: the element whose children don't also contain the snippet.
    const leaf = hits.filter(e => ![...e.children].some(c => c.innerText?.includes(snippet))).pop()
    if (!leaf) return log(`locate: "${snippet}" not found in <main>`)
    const chain = []
    for (let e = leaf; e && e !== document.body && chain.length < 12; e = e.parentElement) chain.push(describe(e))
    log(`locate "${snippet}":\n  ` + chain.join('\n  '))
    return chain
  }

  // relay-main.js calls this right before clicking send.
  const arm = () => {
    armed = new Set(document.querySelectorAll(SEL.assistant))
  }

  window.__replyWatch = { SEL, opts, hooks, turns, arm, diagnose, locate, finishTurn }
})()
