// End-to-end prototype: the WebSocket to the broker, in the background script.
//
// Firefox applies the page's CSP to content-script WebSockets too
// (NS_ERROR_CONTENT_BLOCKED on chatgpt.com), so the socket lives here, under
// the extension's own origin. Each tab's relay-bridge.js opens a port; each
// port gets its own socket, so the broker sees one "page" per tab.
const BROKER = 'ws://127.0.0.1:8777/?role=page'

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'g2-relay') return
  let ws = null
  let backoff = 1000
  let closed = false

  function connect() {
    if (closed) return
    try {
      ws = new WebSocket(BROKER)
    } catch (err) {
      port.postMessage({ json: JSON.stringify({ t: 'bridge', s: `cannot open ${BROKER}: ${err}` }) })
      return setTimeout(connect, 10000)
    }
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      backoff = 1000
      port.postMessage({ json: JSON.stringify({ t: 'bridge', s: 'connected' }) })
    }
    ws.onmessage = e => port.postMessage(typeof e.data === 'string' ? { json: e.data } : { pcm: e.data })
    ws.onclose = () => {
      if (closed) return
      port.postMessage({ json: JSON.stringify({ t: 'bridge', s: `closed, retry in ${backoff / 1000} s` }) })
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 10000)
    }
  }

  port.onMessage.addListener(msg => {
    if (msg.json && ws?.readyState === WebSocket.OPEN) ws.send(msg.json)
  })
  port.onDisconnect.addListener(() => {
    closed = true
    ws?.close()
  })
  connect()
})
