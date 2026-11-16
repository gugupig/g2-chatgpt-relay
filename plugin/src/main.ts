// ChatGPT Relay, glasses side (Even Hub plugin): talk to chatgpt.com through
// the G2 Relay Android app on the same phone, read the whole conversation.
//
//   hold          push to talk: talking while the press lasts
//   swipe up/down scroll the conversation by a screen
//   double tap    menu (while talking: cancel)
// Talking waits until the reply has finished: a turn started over a streaming
// reply took that reply for its own. Every start carries the conversation the
// glasses show, and the page refuses it if another one is open (then sends
// its own), so a turn never lands in a conversation the glasses don't show.
// 刷新 in the menu asks the page to drop a stuck turn and resend the
// conversation; if it doesn't answer, the app reloads chatgpt.com.
// A tap does nothing (it started a talk too easily), except end a talk whose
// release got lost.
//
// The screen has three text containers: a dim status line, the conversation
// and a dimmer hint line. Only the visible screen of the conversation is ever
// sent to the glasses: a container takes ~2 KB per update and less when the
// page is rebuilt, and the firmware ignores partial updates (experiment 6 in
// docs/界面改造方案.md). Keeping the body within one screen also stops the
// firmware scrolling it on its own, so every swipe reaches us.
//
// Audio goes to the broker as binary 16 kHz s16le frames, framed by
// {t: "start"} and {t: "stop"}. The page answers with {t: "status"},
// {t: "transcript"}, {t: "reply", text, done} and {t: "history", turns}.
//
// ?broker=127.0.0.1:8777 overrides the broker address; ?calib=1 shows a
// wrapping test card instead (for tuning LINE_UNITS / BODY_LINES).
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'

const params = new URL(location.href).searchParams
const BROKER = `ws://${params.get('broker') ?? '127.0.0.1:8777'}/?role=glasses`
// Wrapping budget for the 576 px container, in "units": a CJK or full-width
// character counts 2, anything else 1. Simulator calibration (?calib=1): 50
// digits or 24 CJK characters per line, about 28 px per line.
const LINE_UNITS = Number(params.get('units') ?? 48)
const BODY_LINES = Number(params.get('lines') ?? 8)
const MAX_TALK_MS = 60_000
const MIN_TALK_MS = 800
const CACHE_KEY = 'chatrelay.history'
const CACHE_TURNS = 20

const bridge = await waitForEvenAppBridge()

// --- layout ------------------------------------------------------------------
// Measured in the simulator: body lines are ~27.3 px apart; a bare status or
// hint line needs 28 px and clips below that.
const LINE_PX = 28
const BODY_LINE_PX = 27.4
const STATUS = { containerID: 1, containerName: 'status' }
const BODY = { containerID: 2, containerName: 'body' }
const HINT = { containerID: 3, containerName: 'hint' }
const LIST = { containerID: 4, containerName: 'list' }

const box = (ids: { containerID: number; containerName: string }, y: number, h: number, color: number, capture: boolean, content = '', pad = 4) =>
  new TextContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: 576,
    height: h,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: pad,
    ...ids,
    content,
    textColor: color,
    isEventCapture: capture ? 1 : 0,
  })

// Body content stays empty in create/rebuild: those calls fail well below the
// 2 KB an update accepts, so the text follows in a separate update.
// Status and hint are one unpadded line each; the body gets the rest.
const STATUS_H = LINE_PX
const BODY_H = Math.ceil(BODY_LINES * BODY_LINE_PX) + 8
const mainPage = () => ({
  containerTotalNum: 3,
  textObject: [
    box(STATUS, 0, STATUS_H, 2, false, '', 0),
    box(BODY, STATUS_H, BODY_H, 4, true),
    box(HINT, STATUS_H + BODY_H, 288 - STATUS_H - BODY_H, 1, false, '', 0),
  ],
})

await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(mainPage()))

// --- state -------------------------------------------------------------------
type Phase = 'idle' | 'starting' | 'listening' | 'waiting' | 'replying' | 'done' | 'error'
type Turn = { user: string; reply: string; done: boolean }
type Chat = { id: string; title: string; current: boolean }
// A page of the system list: the menu, or a page of the chat list.
type ListPage = { title: string; items: { name: string; run: () => void }[] }
const st = {
  ws: 'connecting' as string,
  page: false,
  phase: 'idle' as Phase,
  detail: '',
  talkStartedAt: 0,
  stoppedAt: 0,
  firstReplyAt: 0,
  doneAt: 0,
  frames: 0,
  turns: [] as Turn[], // finished turns of the open conversation
  live: null as Turn | null, // the turn being talked or answered
  title: '',
  // The conversation shown: its id, null for a new one, undefined if unknown.
  chat: undefined as string | null | undefined,
  cached: false, // turns came from local storage, not yet from the page
  top: 0, // first visible line of the conversation
  pinned: false, // the last turn may scroll to the top of the screen
  list: null as ListPage | null, // the list page on screen instead of the conversation
  chats: null as Chat[] | null, // asked for with list-chats, then shown a page at a time
  notice: '', // one-off hint, e.g. why a talk was dropped
}

// --- wrapping ----------------------------------------------------------------
const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]/.test(ch)
const unitsOf = (ch: string) => (wide(ch) ? 2 : 1)
// Punctuation that must not start a line: it takes the previous character along.
const noStart = (ch: string) => /[，。、；：！？）》」』”’,.;:!?)]/.test(ch)

// Cuts text to one line of at most `width` units, marking the cut with …
function clip(text: string, width: number): string {
  const chars = [...text.replace(/\s+/g, ' ')]
  if (chars.reduce((n, ch) => n + unitsOf(ch), 0) <= width) return chars.join('')
  let units = 1 // the …
  let out = ''
  for (const ch of chars) {
    if ((units += unitsOf(ch)) > width) break
    out += ch
  }
  return out + '…'
}

function wrap(text: string, width = LINE_UNITS): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    if (!para) {
      lines.push('')
      continue
    }
    let line = ''
    let units = 0
    for (const ch of para) {
      const u = unitsOf(ch)
      if (units + u > width) {
        // Break latin words at the last space if it is close enough.
        const sp = line.lastIndexOf(' ')
        if (!wide(ch) && ch !== ' ' && sp > 0 && line.length - sp < 12) {
          lines.push(line.slice(0, sp))
          line = line.slice(sp + 1)
          units = [...line].reduce((n, c) => n + unitsOf(c), 0)
        } else if (noStart(ch) && [...line].length > 1) {
          const chars = [...line]
          const carry = chars.pop()!
          lines.push(chars.join(''))
          line = carry
          units = unitsOf(carry)
        } else {
          lines.push(line)
          line = ''
          units = 0
        }
        if (ch === ' ') continue
      }
      line += ch
      units += u
    }
    lines.push(line)
  }
  // Runs of blank lines waste a screen that only holds a few.
  return lines.filter((l, i) => l !== '' || (i > 0 && lines[i - 1] !== ''))
}

// --- the conversation as lines ---------------------------------------------
// Each turn is a blank separator, the user's words after "› ", then the reply.
// starts[i] is the first line of turn i (the live turn is last).
function transcript(): { lines: string[]; starts: number[] } {
  const lines: string[] = []
  const starts: number[] = []
  const all = st.live ? [...st.turns, st.live] : st.turns
  all.forEach((t, i) => {
    if (i > 0) lines.push('')
    starts.push(lines.length)
    if (t.user) lines.push(...wrap(`› ${t.user}`))
    else if (t === st.live && st.phase !== 'replying' && st.phase !== 'done') lines.push('› …')
    if (t.reply) lines.push(...wrap(t.reply).filter((l, j) => j > 0 || l !== ''))
  })
  if (st.phase === 'error' && st.detail) lines.push('', ...wrap(`× ${st.detail}`))
  return { lines, starts }
}

// The view may sit below the last full screen while a new turn is pinned to
// the top, the way chat apps scroll a new message up: its reply then streams
// into the empty space under the question instead of below the fold.
function maxTop(): number {
  const { lines, starts } = transcript()
  const full = Math.max(0, lines.length - BODY_LINES)
  return st.pinned ? Math.max(full, starts[starts.length - 1] ?? 0) : full
}
// Moves the view to the start of the live turn (or the last one).
function showLatestTurn() {
  const { starts } = transcript()
  st.pinned = true
  st.top = Math.min(starts[starts.length - 1] ?? 0, maxTop())
}

// --- rendering ---------------------------------------------------------------
const secs = (ms: number) => (ms / 1000).toFixed(1)

function statusLine(lines: number): string {
  const step = BODY_LINES - 1
  const last = maxTop()
  const total = Math.ceil(last / step) + 1
  // Screen numbers are approximate (screens overlap by a line); only the last
  // screen shows total/total, and ↓ means more below.
  const at = st.top >= last ? total : Math.min(total - 1, Math.ceil(st.top / step) + 1)
  const pos = lines > BODY_LINES || last > 0 ? `  ${st.top < last ? '↓' : ''}${at}/${total}` : ''
  if (st.list) return st.list.title
  if (st.ws !== 'open') return `○ 未连接 G2 Relay · ${st.ws}`
  if (!st.page) return '○ chatgpt.com 页面未就绪'
  const turn = st.turns.length + (st.live ? 1 : 0)
  const now = performance.now()
  switch (st.phase) {
    case 'idle':
    case 'done': {
      const tag = st.cached ? '（缓存）' : ''
      if (st.phase === 'done' && st.live === null && st.doneAt) {
        const last = st.turns[st.turns.length - 1]
        return `■ 第 ${turn} 轮完成 · ${last?.reply.length ?? 0} 字 · ${secs(st.doneAt - st.stoppedAt)}s${tag}${pos}`
      }
      const title = st.title && st.title !== 'ChatGPT' ? `${clip(st.title, 20)} · ` : ''
      return `● ${turn ? `${title}第 ${turn} 轮` : '新对话'}${tag}${pos}`
    }
    case 'starting':
      return '◎ 准备听写…'
    case 'listening':
      return `● 听写中 ${secs(now - st.talkStartedAt)}s`
    case 'waiting':
      return `… ${st.detail || '处理中'} ${secs(now - st.stoppedAt)}s`
    case 'replying':
      return `▶ 输出中 ${secs(now - st.stoppedAt)}s · ${st.live?.reply.length ?? 0} 字${pos}`
    case 'error':
      return `× 出错 · 按住重说${pos}`
  }
}

// Shows a one-off hint instead of the usual one until it times out or is replaced.
function flash(text: string, ms = 2500) {
  st.notice = text
  render()
  setTimeout(() => {
    if (st.notice === text) (st.notice = ''), render()
  }, ms)
}

function hintLine(): string {
  if (st.list) return '滑动选择 · 单击执行 · 双击返回'
  if (st.notice) return st.notice
  switch (st.phase) {
    case 'starting':
    case 'listening':
      return '松开发送 · 双击取消'
    case 'waiting':
    case 'replying':
      return '滑动翻看 · 双击菜单'
    default:
      return '按住说话 · 滑动翻看 · 双击菜单'
  }
}

const shown = { status: '', body: '', hint: '' }
let rendering = false
let dirty = false
function render() {
  dirty = true
  if (rendering) return
  rendering = true
  void (async () => {
    while (dirty) {
      dirty = false
      if (st.list) break
      const { lines } = transcript()
      st.top = Math.max(0, Math.min(st.top, maxTop()))
      const next = {
        status: statusLine(lines.length),
        body: lines.slice(st.top, st.top + BODY_LINES).join('\n'),
        hint: hintLine(),
      }
      for (const [key, ids] of [['body', BODY], ['status', STATUS], ['hint', HINT]] as const) {
        if (next[key] === shown[key]) continue
        shown[key] = next[key]
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...ids, content: next[key] || ' ' }))
      }
      await new Promise(r => setTimeout(r, 120)) // the BLE link is the bottleneck; don't queue updates
    }
    rendering = false
  })()
}

// --- menu and chat list ------------------------------------------------------
// The firmware's own contextual menu doesn't open on the G2 (experiment 6), so
// the menu is a page of its own with a system list. The list moves its
// selection without telling us, so it can't wrap around: 退出 sits near the top.
const MENU: ListPage = {
  title: '菜单',
  items: [
    { name: '新对话', run: () => newChat() },
    { name: '历史对话', run: () => listChats() },
    { name: '退出', run: () => void bridge.shutDownPageContainer(1) },
    { name: '刷新', run: () => refresh() },
    { name: '跳到最新一轮', run: () => showLatestTurn() },
    { name: '回到开头', run: () => void ((st.top = 0), (st.pinned = false)) },
    { name: '返回', run: () => {} },
  ],
}

async function openList(page: ListPage) {
  st.list = page
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 3,
      textObject: [box(STATUS, 0, STATUS_H, 2, false, page.title, 0), box(HINT, 288 - STATUS_H, STATUS_H, 1, false, hintLine(), 0)],
      listObject: [
        new ListContainerProperty({
          xPosition: 0,
          yPosition: STATUS_H,
          width: 576,
          height: 288 - 2 * STATUS_H,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 4,
          ...LIST,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({
            itemCount: page.items.length,
            itemWidth: 560,
            isItemSelectBorderEn: 1,
            itemName: page.items.map(i => i.name),
          }),
        }),
      ],
    }),
  )
}

async function closeList(pick?: number) {
  const page = st.list
  st.list = null
  await bridge.rebuildPageContainer(new RebuildPageContainer(mainPage()))
  shown.status = shown.body = shown.hint = ''
  if (pick !== undefined) page?.items[pick]?.run()
  render()
}

// The page answers list-chats with {t: "chats"}; the list then opens. A rebuild
// over about 1 KB fails on the glasses (experiment 6), so it goes a few short
// titles at a time.
const CHATS_PER_PAGE = 8
const CHAT_TITLE_UNITS = 24
function listChats() {
  if (st.ws !== 'open' || !st.page) return flash('手机上的 chatgpt.com 没连上')
  st.chats = null
  send({ t: 'list-chats' })
  flash('正在读取对话列表…', 6000)
}

function chatsPage(n: number): ListPage {
  const chats = st.chats ?? []
  const pages = Math.max(1, Math.ceil(chats.length / CHATS_PER_PAGE))
  const items = chats.slice(n * CHATS_PER_PAGE, (n + 1) * CHATS_PER_PAGE).map(c => ({
    name: `${c.current ? '● ' : ''}${clip(c.title || '（无标题）', CHAT_TITLE_UNITS)}`,
    run: () => openChat(c),
  }))
  if (pages > 1) items.push({ name: n + 1 < pages ? '更多…' : '回到第一页', run: () => void openList(chatsPage((n + 1) % pages)) })
  items.push({ name: '返回', run: () => {} })
  return { title: `历史对话 ${n + 1}/${pages} · 共 ${chats.length} 个`, items }
}

function openChat(c: Chat) {
  if (c.current) return showLatestTurn()
  if (busy()) return flash('说完或等回复结束后再切换')
  // Show nothing of the old conversation meanwhile; its history follows.
  st.turns = []
  st.live = null
  st.title = c.title
  st.chat = c.id
  st.cached = false
  st.top = 0
  send({ t: 'open-chat', id: c.id })
  flash(`正在打开：${clip(c.title, 30)}`, 8000)
}

// Asks the page to drop whatever turn is stuck and resend the conversation;
// a page that doesn't answer in time gets reloaded by the app.
const REFRESH_MS = 10_000
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function refresh() {
  if (st.ws !== 'open') return flash('手机上的 G2 Relay 没连上')
  if (st.phase === 'listening' || st.phase === 'starting') void stopTalk(false)
  st.live = null
  st.phase = 'idle'
  st.detail = ''
  if (refreshTimer) clearTimeout(refreshTimer)
  if (!st.page) return reloadPage()
  send({ t: 'refresh' })
  flash('正在刷新…', REFRESH_MS)
  refreshTimer = setTimeout(reloadPage, REFRESH_MS)
}
function reloadPage() {
  refreshTimer = null
  send({ t: 'reload' })
  flash('页面没响应，正在重新加载网页…', 20_000)
}

// --- local cache -------------------------------------------------------------
// The last turns, so reopening the plugin shows the conversation at once.
async function saveCache() {
  const turns = st.turns.slice(-CACHE_TURNS).map(t => ({ ...t, reply: t.reply.slice(0, 4000) }))
  await bridge.setLocalStorage(CACHE_KEY, JSON.stringify({ title: st.title, chat: st.chat, turns }))
}

async function loadCache() {
  try {
    const raw = await bridge.getLocalStorage(CACHE_KEY)
    if (!raw || st.turns.length) return
    const c = JSON.parse(raw)
    if (!Array.isArray(c.turns)) return
    st.turns = c.turns
    st.title = c.title ?? ''
    st.chat = c.chat
    st.cached = true
    showLatestTurn()
    render()
  } catch {
    // A broken cache only costs the instant start.
  }
}

// --- broker connection -----------------------------------------------------
let ws: WebSocket | null = null
let backoff = 1000
const send = (obj: Record<string, unknown>) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj))

function connect() {
  ws = new WebSocket(BROKER)
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    backoff = 1000
    st.ws = 'open'
    render()
  }
  ws.onclose = ev => {
    st.ws = `${backoff / 1000}s 后重连`
    console.debug(`[relay] broker closed ${ev.code}`)
    st.page = false
    if (st.phase === 'listening' || st.phase === 'starting') void stopTalk(false)
    render()
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 10_000)
  }
  ws.onmessage = ev => {
    if (typeof ev.data !== 'string') return
    onMessage(JSON.parse(ev.data))
  }
}

// The page reports errors in English; the common ones get a Chinese line.
const ERRORS: [RegExp, string][] = [
  [/^audio not armed/, '页面音频没激活：在手机上点一下 chatgpt.com 页面'],
  [/^dictation button not found/, '找不到听写按钮（ChatGPT 页面可能没登录或改版）'],
  [/^page did not open the mic/, 'ChatGPT 页面没有打开麦克风'],
  [/^dictation done button not found/, '找不到结束听写按钮'],
  [/^transcript empty/, '听写结果为空，可能没录到声音'],
  [/^no transcribe response/, 'ChatGPT 没有返回听写结果'],
  [/^send button not found/, '找不到发送按钮'],
  [/^new chat button not found/, '找不到新对话按钮'],
  [/^new chat did not open/, '新对话没有打开'],
  [/^chat not found in the sidebar/, '侧边栏里找不到这个对话'],
  [/^chat did not open/, '对话没有打开'],
  [/^page shows another chat/, '手机上打开的是另一个对话，已同步过来，请再说一次'],
  [/^reply still in progress/, 'ChatGPT 还在回复，等它说完再说话'],
  [/^no reply started/, 'ChatGPT 一分钟没有回复；可以双击菜单 → 刷新'],
  [/^reply timed out/, '回复超时；可以双击菜单 → 刷新'],
  [/^composer not empty/, '输入框里的旧文字删不掉，这一轮没有发出；请在手机上手动清空'],
]
const errorText = (e: string) => ERRORS.find(([re]) => re.test(e))?.[1] ?? e

const busy = () => st.phase === 'starting' || st.phase === 'listening' || st.phase === 'waiting' || st.phase === 'replying'

function onMessage(msg: any) {
  switch (msg.t) {
    case 'peer':
      if (msg.page && !st.page) send({ t: 'get-history' })
      // A reload or crash mid-turn: no reply is coming.
      if (!msg.page && st.page && busy()) pageLost()
      st.page = !!msg.page
      break
    case 'history':
      // Mid-turn the live turn is newer than the page's DOM; it arrives again later.
      if (busy()) break
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = null
      st.notice = ''
      st.turns = (msg.turns as Turn[]).map(t => ({ user: t.user ?? '', reply: t.reply ?? '', done: true }))
      st.live = null
      st.title = msg.title ?? ''
      st.chat = msg.chat ?? null
      st.cached = false
      if (st.phase === 'error') st.phase = 'idle'
      showLatestTurn()
      void saveCache()
      if (msg.why === 'resync') flash('已同步到手机上打开的对话，请再说一次', 5000)
      else if (msg.why === 'refresh') flash('已刷新', 2000)
      break
    case 'chats':
      st.chats = msg.chats as Chat[]
      st.notice = ''
      if (!st.chats.length) flash('侧边栏里没有对话')
      else if (!st.list && !busy()) void openList(chatsPage(0))
      break
    case 'status':
      if (msg.s === 'error') {
        st.notice = ''
        st.phase = 'error'
        st.detail = errorText(String(msg.error ?? '未知错误'))
        if (talkTimer) clearInterval(talkTimer)
        talkTimer = null
        void bridge.audioControl(false)
        showLatestTurn()
      } else if (msg.s === 'listening' && st.phase === 'starting') {
        st.phase = 'listening'
      } else if (st.phase === 'waiting') {
        st.detail = { finishing: '结束听写', transcribing: '转写中', sent: '等待回复' }[msg.s as string] ?? msg.s
      }
      break
    case 'transcript':
      if (st.live) st.live.user = msg.text
      break
    case 'reply':
      if (st.phase === 'listening' || st.phase === 'starting' || !st.live) break
      if (!st.firstReplyAt && msg.text) {
        st.firstReplyAt = performance.now()
        send({ t: 'metric', firstTextAfterStopMs: Math.round(st.firstReplyAt - st.stoppedAt) })
      }
      st.live.reply = msg.text
      st.phase = msg.done ? 'done' : 'replying'
      if (msg.done) {
        if ('chat' in msg) st.chat = msg.chat
        send({ t: 'metric', doneAfterStopMs: Math.round(performance.now() - st.stoppedAt), replyChars: msg.text.length, lines: wrap(msg.text).length })
        st.live.done = true
        st.doneAt = performance.now()
        st.turns.push(st.live)
        st.live = null
        void saveCache()
      }
      break
  }
  render()
}

function pageLost() {
  if (talkTimer) clearInterval(talkTimer)
  talkTimer = null
  void bridge.audioControl(false)
  st.live = null
  st.phase = 'error'
  st.detail = '手机上的 chatgpt.com 页面断开了，这一轮没有发出或没收到回复'
}

function newChat() {
  st.turns = []
  st.live = null
  st.top = 0
  st.title = ''
  st.chat = null
  st.cached = false
  st.firstReplyAt = 0
  st.phase = 'idle'
  send({ t: 'new-chat' })
  void saveCache()
}

// --- talking ---------------------------------------------------------------
let talkTimer: ReturnType<typeof setInterval> | null = null

async function startTalk() {
  if (st.ws !== 'open' || !st.page) return render()
  st.phase = 'starting'
  st.live = { user: '', reply: '', done: false }
  st.frames = 0
  st.firstReplyAt = 0
  st.doneAt = 0
  st.detail = ''
  st.talkStartedAt = performance.now()
  showLatestTurn()
  render()
  send(st.chat === undefined ? { t: 'start' } : { t: 'start', chat: st.chat })
  // Never leave a second timer running (a leaked one kept sending "stop" every 500 ms).
  if (talkTimer) clearInterval(talkTimer)
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
  // The page may already have refused the turn (another chat, a reply still going).
  if (st.phase !== 'starting' && st.phase !== 'listening') return void bridge.audioControl(false)
  if (!ok) {
    st.phase = 'error'
    st.detail = '眼镜麦克风没有启动'
    st.live = null
    send({ t: 'cancel' })
    return render()
  }
  talkTimer = setInterval(() => {
    if (st.phase !== 'listening' && st.phase !== 'starting') {
      if (talkTimer) clearInterval(talkTimer)
      talkTimer = null
    } else if (performance.now() - st.talkStartedAt > MAX_TALK_MS) void stopTalk(true)
    else render()
  }, 500)
}

async function stopTalk(sendIt: boolean) {
  if (talkTimer) clearInterval(talkTimer)
  talkTimer = null
  await bridge.audioControl(false)
  st.stoppedAt = performance.now()
  // A brush of the touchpad records next to nothing, and ChatGPT answers that
  // with an empty transcript: drop it instead.
  if (sendIt && st.stoppedAt - st.talkStartedAt < MIN_TALK_MS) {
    sendIt = false
    flash('太短，已取消 · 按住说话')
  }
  if (sendIt) {
    send({ t: 'stop', frames: st.frames, talkMs: Math.round(st.stoppedAt - st.talkStartedAt) })
    st.phase = 'waiting'
    st.detail = '结束听写'
    // Ticks the waiting/replying clock on the status line only.
    const tick = setInterval(() => (st.phase === 'waiting' || st.phase === 'replying' ? render() : clearInterval(tick)), 500)
  } else {
    send({ t: 'cancel' })
    st.live = null
    st.phase = 'idle'
  }
  render()
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function scroll(dir: 1 | -1) {
  // Scrolling back releases the pin; the conversation then ends at the bottom edge.
  if (dir < 0) st.pinned = false
  st.top = Math.max(0, Math.min(st.top + dir * (BODY_LINES - 1), maxTop()))
  render()
}

bridge.onEvenHubEvent(event => {
  if (event.audioEvent) {
    if (st.phase === 'starting' || st.phase === 'listening') {
      st.frames++
      if (ws?.readyState === WebSocket.OPEN) ws.send(new Uint8Array(event.audioEvent.audioPcm))
    }
    return
  }
  if (st.list) {
    // The list moves its own selection; only a click reaches us. The first
    // item's index is left out of the event, so a missing one means 0.
    if (event.listEvent && eventTypeOf(event.listEvent) === OsEventTypeList.CLICK_EVENT) void closeList(event.listEvent.currentSelectItemIndex ?? 0)
    else if (eventTypeOf(event.sysEvent) === OsEventTypeList.DOUBLE_CLICK_EVENT) void closeList()
    return
  }
  const type = eventTypeOf(event.sysEvent) ?? eventTypeOf(event.textEvent)
  const talking = st.phase === 'listening' || st.phase === 'starting'
  switch (type) {
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return void (talking ? stopTalk(false) : openList(MENU))
    case OsEventTypeList.CLICK_EVENT:
      // Only ends a talk whose release never arrived.
      if (st.phase === 'listening') void stopTalk(true)
      return
    case OsEventTypeList.LONG_PRESS_EVENT:
      if (st.phase === 'waiting' || st.phase === 'replying') flash('等回复结束再说话 · 卡住了就双击菜单 → 刷新', 4000)
      else if (!talking) void startTalk()
      return
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      if (talking) void stopTalk(true)
      return
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return scroll(1)
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return scroll(-1)
  }
})

if (params.get('calib')) {
  // Each line should fill the width exactly; the last visible line shows how many fit.
  const rows = ['1234567890'.repeat(5), '中'.repeat(23) + '|', '中'.repeat(24) + '|', 'Mixed 中英 text with spaces 混排测试'.repeat(2)]
  for (let i = 1; i <= 10; i++) rows.push(`line ${i} ` + '一二三四五六七八九十'.repeat(2))
  void bridge.textContainerUpgrade(new TextContainerUpgrade({ ...BODY, content: rows.join('\n') }))
} else {
  await loadCache()
  connect()
  render()
}
