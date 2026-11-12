// End-to-end prototype, page side: drives chatgpt.com from glasses commands.
//
//   start  → open a live synthetic-mic turn, click the dictation button
//   PCM    → push into the live stream
//   stop   → let the audio play out, click the dictation "done" button, wait
//            for the transcript to land in the composer, click send
//   cancel → click the dictation cancel button
//   get-history → {t: "history", chat, title, turns: [{user, reply, done}]}
//   new-chat    → open a new conversation, then send its (empty) history
//   list-chats  → {t: "chats", chats: [{id, title, current}]} from the sidebar
//   open-chat   → {id}: open that conversation, then send its history
// The reply is read by reply-watch.js and forwarded as {t: "reply"} updates.
//
// Runs in the page's MAIN world after synth-mic.js and reply-watch.js. The
// WebSocket lives in relay-bridge.js (isolated world, outside the page's CSP);
// the two talk through window.postMessage with string tags.
(() => {
  if (window.__relay) return
  const mic = window.__synthMic
  const watch = window.__replyWatch
  if (!mic || !watch) return console.error('[relay] synth-mic.js / reply-watch.js missing')

  // Button labels follow the UI language. Each entry is a list of regexes
  // tried against aria-label; {t: "config"} from the broker can replace them
  // while the page is open, so the phone's labels can be fixed without a reinstall.
  // Patterns are anchored: a loose '取消' also matched the sidebar's
  // '取消置顶聊天' (unpin chat). Labels seen on the phone on 2026-11-07:
  // 听写 → 取消听写 / 停止听写 / 转录并发送. Buttons in nav/aside never match.
  const CFG = {
    dictate: ['^Dictate$', '^听写$'],
    dictateDone: ['^Stop dictation$', '^停止听写$', '^Submit dictation$'],
    dictateCancel: ['^Cancel dictation$', '^取消听写$'],
    send: ['^Send prompt$', '^发送提示$', '^发送$', '^发送消息$'],
    sendCss: 'button[data-testid="send-button"], #composer-submit-button, form button[type="submit"]',
    voiceMode: ['Voice', '语音模式', '开始语音'], // never click these: they open voice mode, not dictation
    composer: '#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"][id*="prompt"], form [contenteditable="true"], form textarea',
    autoSend: true,
    transcriptTimeoutMs: 20000,
    replyThrottleMs: 250,
  }

  const log = (...a) => mic.log('[relay]', ...a)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  let t0 = 0 // performance.now() at "start", for latency numbers
  const at = () => Math.round(performance.now() - t0)

  function toBridge(msg) {
    window.postMessage('g2>bridge:' + JSON.stringify(msg), '*')
  }
  function status(s, extra = {}) {
    log(`status ${s} at ${at()} ms`, extra)
    toBridge({ t: 'status', s, at: at(), ...extra })
  }

  // --- DOM helpers -------------------------------------------------------
  const visible = el => !!el && el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
  const labelOf = el => el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 40)
  const buttons = () =>
    [...document.querySelectorAll('button, [role="button"]')].filter(b => b.offsetParent !== null && !b.closest('nav, aside'))
  function findButton(patterns, { among } = {}) {
    const res = patterns.map(p => new RegExp(p, 'i'))
    const avoid = CFG.voiceMode.map(p => new RegExp(p, 'i'))
    for (const re of res) {
      for (const b of among ?? buttons()) {
        const l = labelOf(b)
        if (!l || !re.test(l)) continue
        if (patterns !== CFG.voiceMode && avoid.some(v => v.test(l))) continue
        return b
      }
    }
    return null
  }
  // React listens to pointer and mouse events as well as click.
  function press(el) {
    const o = { bubbles: true, cancelable: true, view: window }
    el.dispatchEvent(new PointerEvent('pointerdown', o))
    el.dispatchEvent(new MouseEvent('mousedown', o))
    el.dispatchEvent(new PointerEvent('pointerup', o))
    el.dispatchEvent(new MouseEvent('mouseup', o))
    el.click()
  }
  async function waitFor(fn, timeoutMs, stepMs = 100) {
    const end = performance.now() + timeoutMs
    for (;;) {
      const v = fn()
      if (v) return v
      if (performance.now() > end) return null
      await sleep(stepMs)
    }
  }
  // chatgpt.com can keep the previous conversation mounted but hidden after a
  // client-side switch, composer included, so only what is laid out counts.
  const shown = el => el.getClientRects().length > 0
  const composer = () => [...document.querySelectorAll(CFG.composer)].find(shown) ?? null
  const composerText = () => {
    const c = composer()
    return c ? (c.value ?? c.innerText ?? '').trim() : ''
  }
  function clearComposer() {
    const c = composer()
    if (!c) return
    c.focus()
    document.execCommand('selectAll')
    document.execCommand('delete')
  }
  const labelSet = () => new Set(buttons().map(labelOf).filter(Boolean))

  // --- turn state machine --------------------------------------------------
  let phase = 'idle'
  let before = null // composer text and button labels before dictation
  let streamOpened = null
  let transcribed = null

  mic.state.onStream = (kind, ctxState) => {
    streamOpened = { kind, ctxState, at: at() }
  }
  mic.state.onTranscribe = (code, ms) => {
    transcribed = { code, ms, at: at() }
  }

  // Every start and cancel bumps turnId. A start or stop still waiting on the
  // page when that happens drops out quietly: a double tap reaches us as a
  // start followed half a second later by a cancel, while the start waits.
  let turnId = 0
  async function start() {
    await pendingNewChat
    if (phase !== 'idle' && phase !== 'error') await cancel('new start')
    const id = ++turnId
    const stale = () => id !== turnId
    t0 = performance.now()
    phase = 'starting'
    streamOpened = transcribed = null
    mic.live.begin() // queue frames from the first one, even before the page opens the mic
    const ctx = mic.audioContext()
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), sleep(300)])
      if (stale()) return
      if (ctx.state !== 'running') return fail('audio not armed: tap the chatgpt.com page once', { ctx: ctx.state })
    }
    // A dictation left open by an earlier turn (or still "正在启动听写…")
    // hides the dictate button: cancel it and wait for the button to return.
    if (!findButton(CFG.dictate)) {
      const c = await waitFor(() => findButton(CFG.dictateCancel), 3000)
      if (stale()) return
      if (c) {
        press(c)
        log(`closed a leftover dictation ("${labelOf(c)}")`)
      }
    }
    const btn = await waitFor(() => stale() || findButton(CFG.dictate), 3000)
    if (stale()) return
    if (!btn) return fail('dictation button not found', { buttons: [...labelSet()].slice(0, 40) })
    // chatgpt.com keeps unsent drafts, e.g. a transcript from a failed turn;
    // the glasses cannot see it, so it must not ride along with this one.
    const draft = composerText().length
    if (draft) {
      clearComposer()
      log(`cleared a ${draft}-character draft, ${composerText().length} left`)
    }
    before = { text: composerText(), labels: labelSet() }
    press(btn)
    log(`clicked "${labelOf(btn)}"`)
    const opened = await waitFor(() => stale() || streamOpened, 4000)
    if (stale()) return closeDictation()
    if (!opened) return fail('page did not open the mic after the dictation click')
    phase = 'listening'
    status('listening', { ctx: streamOpened.ctxState })
  }

  // The dictation a cancelled start opened after all.
  async function closeDictation() {
    const c = await waitFor(() => findButton(CFG.dictateCancel), 2000)
    if (c) press(c)
    log(`start dropped after a cancel${c ? `, clicked "${labelOf(c)}"` : ''}`)
    if (phase === 'idle') mic.live.close()
  }

  async function stop() {
    if (phase === 'starting') await waitFor(() => phase !== 'starting', 4000)
    if (phase !== 'listening') return log(`stop ignored in phase ${phase}`)
    const id = turnId
    const stale = () => id !== turnId
    phase = 'finishing'
    status('finishing')
    await mic.live.end()
    if (stale()) return log('stop: a new turn started, dropped this one')
    const added = buttons().filter(b => !before.labels.has(labelOf(b)))
    const done = findButton(CFG.dictateDone, { among: added }) ?? findButton(CFG.dictateDone)
    if (!done) return fail('dictation done button not found', { added: added.map(labelOf) })
    press(done)
    log(`clicked "${labelOf(done)}"`)
    phase = 'transcribing'
    status('transcribing')
    const text = await waitFor(() => {
      if (stale()) return 'stale'
      const now = composerText()
      return transcribed && now && now !== before.text ? now : null
    }, CFG.transcriptTimeoutMs)
    if (stale()) return log('stop: a new turn started, dropped this one')
    mic.live.close()
    if (!text) return fail(transcribed ? `transcript empty (transcribe ${transcribed.code})` : 'no transcribe response')
    toBridge({ t: 'transcript', text, at: at(), transcribeMs: transcribed.ms })
    if (!CFG.autoSend) {
      phase = 'idle'
      return status('ready to send (autoSend off)')
    }
    const send = await waitFor(() => {
      const b = findButton(CFG.send) ?? [...document.querySelectorAll(CFG.sendCss)].find(e => !e.closest('nav, aside'))
      return visible(b) ? b : null
    }, 3000)
    if (!send) return fail('send button not found or disabled', { added: [...labelSet()].filter(l => !before.labels.has(l)) })
    phase = 'sending'
    watch.arm()
    press(send)
    log(`clicked "${labelOf(send)}"`)
    status('sent')
    phase = 'replying'
  }

  async function cancel(why = 'cancel') {
    turnId++
    const c = findButton(CFG.dictateCancel)
    if (c) press(c)
    log(`cancelled (${why}) in phase ${phase}${c ? `, clicked "${labelOf(c)}"` : ''}`)
    mic.live.close()
    phase = 'idle'
    status('idle', { why })
    payHistory()
  }

  function fail(error, extra = {}) {
    phase = 'error'
    mic.live.close()
    log(`ERROR ${error}`, extra)
    toBridge({ t: 'status', s: 'error', error, at: at(), ...extra })
    payHistory()
  }

  // --- reply forwarding ------------------------------------------------------
  // The glasses get glasses-text.js's plain-text rendering, not innerText.
  const replyText = turn => {
    try {
      return turn.el && window.__glassesText ? window.__glassesText.glassesText(turn.el) : turn.text
    } catch (err) {
      log(`glassesText failed: ${err}`)
      return turn.text
    }
  }
  let lastSent = 0
  let pendingTimer = null
  watch.hooks.onStart = turn => {
    toBridge({ t: 'reply', n: turn.n, text: '', done: false, at: at() })
  }
  watch.hooks.onUpdate = turn => {
    const due = lastSent + CFG.replyThrottleMs - performance.now()
    clearTimeout(pendingTimer)
    const sendNow = () => {
      lastSent = performance.now()
      toBridge({ t: 'reply', n: turn.n, text: replyText(turn), done: false, at: at() })
    }
    if (due <= 0) sendNow()
    else pendingTimer = setTimeout(sendNow, due)
  }
  watch.hooks.onDone = (turn, reason) => {
    clearTimeout(pendingTimer)
    toBridge({ t: 'reply', n: turn.n, text: replyText(turn), done: true, reason, at: at() })
    if (phase === 'replying' || phase === 'sending') phase = 'idle'
    payHistory()
  }

  // --- conversation history ----------------------------------------------------
  // The whole open conversation, so the glasses can show earlier turns. Sent
  // when the glasses connect, on {t: "get-history"}, and whenever the page
  // switches to another conversation (chatgpt.com is a single-page app).
  const HISTORY_TURNS = 30
  const NEW_CHAT = ['^New chat$', '^新聊天$', '^新对话$']
  const SIDEBAR = [/^Open sidebar$/i, /^显示侧边栏$/, /^打开边栏$/]
  const CLOSE_SIDEBAR = [/^Close sidebar$/i, /^关闭边栏$/, /^关闭侧边栏$/, /^隐藏侧边栏$/]
  const CHAT_LIST = 20
  const IMAGE_REPLY = '[图片]'
  const TURN = '[data-content-search-turn-key], [data-turn-key], [data-testid^="conversation-turn"], article'
  const userText = el => {
    const t = (el.querySelector('.whitespace-pre-wrap') ?? el).innerText.trim()
    return t.replace(/^(You said|你说)[:：]\s*/, '')
  }
  function readHistory() {
    const sel = `${watch.SEL.user}, ${watch.SEL.assistant}`
    const all = [...document.querySelectorAll(sel)].filter(shown)
    // Keep the outermost match only: a message can carry both kinds of marker.
    const nodes = all.filter(el => !all.some(o => o !== el && o.contains(el)))
    const turns = []
    // Scheduled-task chats have replies with no question in front of them: a
    // reply in another turn container than the last one's starts its own turn.
    const turnOf = el => el.closest(TURN)
    let lastBox = null
    for (const el of nodes) {
      if (el.matches(watch.SEL.user)) {
        turns.push({ user: userText(el), reply: '', done: true })
        lastBox = turnOf(el)
        // An image-only reply has no assistant message box, just pictures.
        if (lastBox && [...lastBox.querySelectorAll('img')].some(img => !el.contains(img))) turns[turns.length - 1].reply = IMAGE_REPLY
      } else {
        const box = turnOf(el)
        const prev = turns[turns.length - 1]
        if (prev?.reply === IMAGE_REPLY) prev.reply = ''
        if (!prev || (prev.reply && box !== lastBox)) turns.push({ user: '', reply: '', done: true })
        lastBox = box
        const last = turns[turns.length - 1]
        const text = replyText({ el: el.querySelector(watch.SEL.assistantText) ?? el, text: el.innerText.trim() })
        last.reply = last.reply ? `${last.reply}\n${text}` : text
      }
    }
    return turns.slice(-HISTORY_TURNS)
  }
  const chatId = () => location.pathname.match(/\/c\/([\w-]+)/)?.[1] ?? null
  let owedHistory = null
  function payHistory() {
    if (owedHistory) void settledHistory(owedHistory)
  }
  function sendHistory(why) {
    // Mid-turn the DOM holds a half-written reply; the glasses already have it.
    // It goes out when the turn ends instead (see payHistory).
    if (phase !== 'idle' && phase !== 'error') {
      owedHistory = why
      return log(`history (${why}) deferred in phase ${phase}`)
    }
    owedHistory = null
    const turns = readHistory()
    toBridge({ t: 'history', why, chat: chatId(), title: document.title.replace(/\s*[-|]\s*ChatGPT$/, ''), turns })
    log(`history (${why}): ${turns.length} turns`)
  }
  // Waits until the message list stops changing, so a freshly opened chat is
  // sent complete rather than half rendered.
  // After a switch the message boxes appear first and the replies' text a
  // moment later: wait until the text stops changing, and a little longer
  // while some reply is still empty (it may really be, e.g. an image).
  async function settledHistory(why) {
    let last = '', same = 0
    for (let i = 0; i < 20 && same < 3; i++) {
      await sleep(300)
      const turns = readHistory()
      const sig = `${turns.length}:${turns.reduce((n, t) => n + t.user.length + t.reply.length, 0)}`
      same = sig === last ? same + 1 : 0
      last = sig
      if (same && turns.every(t => t.reply)) break
    }
    sendHistory(why)
  }
  let lastPath = location.pathname
  let glassesOn = false
  let navigating = false
  setInterval(() => {
    if (navigating || location.pathname === lastPath) return
    lastPath = location.pathname
    void settledHistory('navigated')
  }, 1000)

  // On a phone-width page the new-chat link sits in the collapsed sidebar, so
  // open that first. Never fake it with pushState: the URL changes but React
  // keeps the old conversation and composer, and dictation then goes nowhere.
  // A full page load is no way out either: it drops the audio the user armed.
  function newChatButton() {
    const res = NEW_CHAT.map(p => new RegExp(p, 'i'))
    return [
      ...document.querySelectorAll('[data-testid="create-new-chat-button"]'),
      ...[...document.querySelectorAll('a, button')].filter(e => res.some(re => re.test(e.getAttribute('aria-label') ?? e.textContent.trim()))),
    ].find(visible)
  }
  // Returns find() once it gives something, opening the sidebar if needed;
  // opened tells the caller to close it again when it did not navigate.
  async function inSidebar(find) {
    let el = find()
    if (el) return { el, opened: false }
    const toggle = sidebarButton('open-sidebar-button', SIDEBAR)
    if (!toggle) return { el: null, opened: false }
    press(toggle)
    return { el: await waitFor(find, 5000), opened: true }
  }
  const sidebarButton = (testid, labels) =>
    [...document.querySelectorAll(`[data-testid="${testid}"], button`)]
      .find(e => visible(e) && (e.dataset.testid === testid || labels.some(re => re.test(e.getAttribute('aria-label') ?? ''))))
  function closeSidebar() {
    const b = sidebarButton('close-sidebar-button', CLOSE_SIDEBAR)
    if (b) return press(b)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  // Switching chats sends its own history once the new one has settled.
  async function navigation(fn) {
    navigating = true
    try {
      await fn()
    } finally {
      navigating = false
      lastPath = location.pathname
    }
  }

  let pendingNewChat = null
  async function newChat() {
    if (phase !== 'idle' && phase !== 'error') await cancel('new chat')
    const { el } = await inSidebar(newChatButton)
    if (!el) return fail('new chat button not found')
    press(el)
    log(`new chat: clicked "${labelOf(el)}"`)
    if (!(await waitFor(() => chatId() === null && readHistory().length === 0, 4000))) return fail('new chat did not open')
    lastPath = location.pathname
    await settledHistory('new-chat')
  }

  // The sidebar's conversation links, newest first, one per conversation.
  function chatLinks() {
    const seen = new Map()
    for (const a of document.querySelectorAll('a[href*="/c/"]')) {
      if (!a.closest('nav, aside, #history')) continue
      const id = a.getAttribute('href').match(/\/c\/([\w-]+)/)?.[1]
      if (!id || seen.has(id)) continue
      const title = a.innerText.split('\n').map(l => l.trim()).find(Boolean) ?? a.getAttribute('aria-label') ?? ''
      seen.set(id, { id, title, a })
    }
    return [...seen.values()]
  }
  async function listChats() {
    // Opening the sidebar mid-dictation could steal the composer's focus.
    const idle = phase === 'idle' || phase === 'error'
    const { opened } = idle ? await inSidebar(() => (chatLinks().length ? true : null)) : { opened: false }
    if (opened) await sleep(300) // let the list fill in past the first few
    const current = chatId()
    const chats = chatLinks().slice(0, CHAT_LIST).map(({ id, title }) => ({ id, title, current: id === current }))
    if (opened) closeSidebar()
    toBridge({ t: 'chats', chats, at: at() })
    log(`chats: ${chats.length}`)
  }
  async function openChat(id) {
    if (phase !== 'idle' && phase !== 'error') await cancel('open chat')
    if (chatId() !== id) {
      const { el } = await inSidebar(() => chatLinks().find(c => c.id === id && visible(c.a))?.a ?? null)
      if (!el) return fail('chat not found in the sidebar')
      press(el)
      log('open chat: clicked')
      if (!(await waitFor(() => chatId() === id, 4000))) return fail('chat did not open')
      // A phone-width sidebar may stay open over the conversation.
      if (sidebarButton('close-sidebar-button', CLOSE_SIDEBAR)) closeSidebar()
    }
    lastPath = location.pathname
    await waitFor(() => readHistory().length > 0, 4000)
    await settledHistory('open-chat')
  }

  // --- debugging -----------------------------------------------------------
  function inspect() {
    const c = composer()
    return {
      t: 'inspect',
      url: location.pathname,
      phase,
      ctx: mic.state.ctx?.state ?? 'none',
      composer: c ? `${c.tagName.toLowerCase()}#${c.id}` : null,
      dictate: labelOf(findButton(CFG.dictate) ?? document.createElement('i')) || null,
      send: labelOf(findButton(CFG.send) ?? document.querySelector(CFG.sendCss) ?? document.createElement('i')) || null,
      sendCss: [...document.querySelectorAll(CFG.sendCss)].map(e => `${e.id || '-'} | ${e.dataset.testid ?? '-'} | ${e.getAttribute('aria-label') ?? '-'}`),
      buttons: [...labelSet()],
      composers: [...document.querySelectorAll(CFG.composer)].map(e => `${e.tagName.toLowerCase()}#${e.id} shown=${shown(e)} len=${(e.value ?? e.innerText ?? '').trim().length}`),
      chatLinks: `${chatLinks().length} (${chatLinks().filter(c => visible(c.a)).length} visible)`,
      messages: (els => `${els.filter(shown).length}/${els.length} shown`)([...document.querySelectorAll(`${watch.SEL.user}, ${watch.SEL.assistant}`)]),
    }
  }

  // --- messages from the bridge ----------------------------------------------
  // No e.source check: Firefox hands the page a different window object for
  // messages posted from the isolated world. The string tags tell them apart.
  addEventListener('message', e => {
    const d = e.data
    if (d && typeof d === 'object' && d.g2pcm) return phase === 'listening' || phase === 'starting' ? mic.live.push(d.g2pcm) : undefined
    if (typeof d !== 'string' || !d.startsWith('g2>page:')) return
    const msg = JSON.parse(d.slice(8))
    switch (msg.t) {
      case 'start':
        return start().catch(err => fail(String(err)))
      case 'stop':
        return stop().catch(err => fail(String(err)))
      case 'cancel':
        return cancel()
      case 'clear':
        // Empties the composer (after a dry run with autoSend off).
        clearComposer()
        return toBridge({ t: 'cleared', left: composerText() })
      case 'inspect':
        return toBridge(inspect())
      case 'config':
        for (const [k, v] of Object.entries(msg.cfg ?? {})) if (k in CFG) CFG[k] = v
        log('config updated', msg.cfg)
        return toBridge({ t: 'config-ok', cfg: CFG })
      case 'get-history':
        return void settledHistory('asked')
      case 'list-chats':
        return listChats().catch(err => fail(String(err)))
      case 'open-chat':
        return navigation(() => openChat(String(msg.id))).catch(err => fail(String(err)))
      case 'new-chat':
        return (pendingNewChat = navigation(newChat).catch(err => fail(String(err))))
      case 'peer':
        log(`peers: glasses ${msg.glasses ? 'on' : 'off'}`)
        if (msg.glasses && !glassesOn) void settledHistory('glasses connected')
        glassesOn = !!msg.glasses
        return
      case 'bridge':
        return log(`bridge ${msg.s}`)
    }
  })

  // On the local mock, mirror the panel log to the mock server (same origin,
  // so the page CSP allows it) for debugging without devtools.
  if (location.hostname === '127.0.0.1') {
    mic.state.onLog = line => navigator.sendBeacon('/__log', line)
    for (const line of mic.state.events) navigator.sendBeacon('/__log', line)
  }

  window.__relay = { CFG, inspect, start, stop, cancel, readHistory, newChat, get phase() { return phase } }
  log('relay ready')
})()
