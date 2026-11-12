// End-to-end prototype: carries messages between relay-main.js (page world)
// and relay-bg.js (background, which holds the WebSocket).
//
// Page side: window.postMessage, JSON as 'g2>page:' / 'g2>bridge:' strings and
// PCM as {g2pcm}. Background side: a runtime port, reopened if the background
// script restarts. The 10 s keepalive also stops Firefox from idling out the
// background event page while a tab is open.
(() => {
  const toPage = msg => window.postMessage('g2>page:' + JSON.stringify(msg), '*')
  let port = null

  function open() {
    port = browser.runtime.connect({ name: 'g2-relay' })
    port.onMessage.addListener(m => {
      if (m.json) window.postMessage('g2>page:' + m.json, '*')
      else if (m.pcm) window.postMessage({ g2pcm: m.pcm }, '*')
    })
    port.onDisconnect.addListener(() => {
      toPage({ t: 'bridge', s: 'background disconnected, reopening' })
      port = null
      setTimeout(open, 1000)
    })
  }

  window.addEventListener('message', e => {
    if (typeof e.data !== 'string' || !e.data.startsWith('g2>bridge:')) return
    port?.postMessage({ json: e.data.slice(10) })
  })
  setInterval(() => port?.postMessage({ json: JSON.stringify({ t: 'ping', ts: Date.now() }) }), 10000)

  toPage({ t: 'bridge', s: 'loaded' })
  open()
})()
