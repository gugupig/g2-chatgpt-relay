// Turns a rendered chatgpt.com reply into plain text for the glasses.
//
// The glasses show one firmware font with no bold, sizes or colors, so
// structure has to be spelled out in characters. innerText alone loses list
// markers and numbers (they are CSS), runs table cells together with tabs,
// keeps "Copy code" button text and prints KaTeX formulas twice. This walks
// the reply DOM instead:
//   headings  → MARK.heading + text, on their own line
//   ul / ol   → "• " / "1. " (nested lists indented two spaces)
//   tables    → one line per row, cells joined with " | "
//   pre/code  → the code text only, no toolbar
//   KaTeX     → the TeX source once
//   buttons, svg, img, widgets → dropped
// Markers live in MARK so they can be swapped once experiment 5 shows which
// glyphs the glasses' font has.
(() => {
  const MARK = { heading: '■ ', bullet: '• ', rule: '————', quote: '> ' }
  const SKIP = new Set(['BUTTON', 'SVG', 'IMG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE'])
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR', 'FIGURE'])

  function inline(node) {
    let s = ''
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) s += c.textContent
      else if (c.nodeType === Node.ELEMENT_NODE) s += element(c, '', true)
    }
    return s
  }

  function katex(el) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')
    return tex ? tex.textContent.trim() : (el.querySelector('.katex-html') ?? el).textContent
  }

  // Returns text for one element; block elements end with "\n".
  function element(el, indent, inInline = false) {
    const tag = el.tagName.toUpperCase()
    if (SKIP.has(tag) || el.getAttribute?.('aria-hidden') === 'true') return ''
    if (el.classList?.contains('katex-display') || el.classList?.contains('katex')) return katex(el) + (el.classList.contains('katex-display') ? '\n' : '')
    if (tag === 'BR') return '\n'
    if (/^H[1-6]$/.test(tag)) return `\n${MARK.heading}${inline(el).trim()}\n`
    if (tag === 'HR') return `${MARK.rule}\n`
    if (tag === 'PRE') {
      const code = el.querySelector('code') ?? el
      return code.textContent.replace(/\n+$/, '') + '\n'
    }
    if (tag === 'UL' || tag === 'OL') {
      let n = Number(el.getAttribute('start') ?? 1)
      let s = ''
      for (const li of el.children) {
        if (li.tagName !== 'LI') continue
        const marker = tag === 'OL' ? `${n++}. ` : MARK.bullet
        let head = ''
        let rest = ''
        for (const c of li.childNodes) {
          if (c.nodeType === Node.ELEMENT_NODE && (c.tagName === 'UL' || c.tagName === 'OL')) rest += element(c, indent + '  ')
          else if (c.nodeType === Node.ELEMENT_NODE && BLOCK.has(c.tagName) && head) rest += indent + '  ' + element(c, indent + '  ').trimStart()
          else head += c.nodeType === Node.TEXT_NODE ? c.textContent : element(c, indent, true)
        }
        s += `${indent}${marker}${head.trim().replace(/\n+/g, ' ')}\n${rest}`
      }
      return s
    }
    if (tag === 'TABLE') {
      return [...el.rows].map(r => [...r.cells].map(c => inline(c).trim().replace(/\s+/g, ' ')).join(' | ')).join('\n') + '\n'
    }
    if (tag === 'BLOCKQUOTE') {
      return blocks(el, indent).trim().split('\n').map(l => MARK.quote + l).join('\n') + '\n'
    }
    if (inInline || !BLOCK.has(tag)) return inline(el)
    return blocks(el, indent)
  }

  // Children of a block: runs of inline content become one line each.
  function blocks(el, indent) {
    let s = ''
    let line = ''
    const flush = () => {
      if (line.trim()) s += indent + line.trim() + '\n'
      line = ''
    }
    for (const c of el.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) line += c.textContent
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = c.tagName.toUpperCase()
        if (BLOCK.has(tag) || c.classList?.contains('katex-display')) {
          flush()
          s += element(c, indent)
        } else line += element(c, indent, true)
      }
    }
    flush()
    return s
  }

  function glassesText(el) {
    const root = el.querySelector('[data-markdown-text-style="assistant-message"], .markdown') ?? el
    return blocks(root, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  window.__glassesText = { glassesText, MARK }
})()
