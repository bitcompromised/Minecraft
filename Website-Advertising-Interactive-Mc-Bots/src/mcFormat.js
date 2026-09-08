// Minecraft legacy "§" formatting -> safe HTML.
//
// Minecraft's classic colour scheme puts a section sign in front of the text
// it applies to: "§cRed §land bold". Servers, anvil-renamed items, scoreboard
// teams and plugin chat all still emit these codes, and prismarine-chat does
// not render them - its toString() strips them and its toHTML() prints them
// as literal text, so neither produces colour (see the message handler in
// src/botChild.js, which renders from toMotd() through this instead).
//
// Server-side only. Chat lines, item names and player names are all rendered
// to escaped HTML here before they are sent, so nothing in the browser has to
// parse formatting - or be trusted to escape it.
//
// Codes:
//   §0-§9, §a-§f  colour        §k  obfuscated
//   §l  bold      §m  strike    §n  underline   §o  italic   §r  reset

const COLORS = {
  0: '#000000', 1: '#0000aa', 2: '#00aa00', 3: '#00aaaa',
  4: '#aa0000', 5: '#aa00aa', 6: '#ffaa00', 7: '#aaaaaa',
  8: '#555555', 9: '#5555ff', a: '#55ff55', b: '#55ffff',
  c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
}

const STYLES = {
  l: 'font-weight:bold',
  m: 'text-decoration:line-through',
  n: 'text-decoration:underline',
  o: 'font-style:italic',
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// True when the text carries at least one formatting code worth rendering.
function hasCodes(text) {
  return typeof text === 'string' && /§[0-9a-fk-or]/i.test(text)
}

// Strips every code, leaving readable plain text. Used for filenames,
// CSV/text exports, and anywhere HTML would be wrong.
function strip(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/§[0-9a-fk-or]/gi, '')
}

/* Renders to HTML. The output is fully escaped - the only markup is the
 * <span style> wrappers this builds itself - so it is safe to assign with
 * innerHTML. Obfuscated text (§k) is rendered as-is rather than animated;
 * it gets a class so a stylesheet can decide what to do with it. */
function toHtml(text) {
  if (typeof text !== 'string' || text.length === 0) return ''

  let color = null
  const active = new Set()
  let obfuscated = false
  let buffer = ''
  let out = ''

  const flush = () => {
    if (!buffer) return
    const styles = []
    if (color) styles.push(`color:${color}`)
    active.forEach((code) => styles.push(STYLES[code]))
    const cls = obfuscated ? ' class="mc-obfuscated"' : ''
    if (styles.length || obfuscated) {
      out += `<span${cls}${styles.length ? ` style="${styles.join(';')}"` : ''}>${escapeHtml(buffer)}</span>`
    } else {
      out += escapeHtml(buffer)
    }
    buffer = ''
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '§' || i === text.length - 1) {
      buffer += ch
      continue
    }

    const code = text[i + 1].toLowerCase()
    if (!/[0-9a-fk-or]/.test(code)) {
      buffer += ch
      continue
    }

    flush()
    i += 1

    if (code === 'r') {
      color = null
      active.clear()
      obfuscated = false
    } else if (COLORS[code]) {
      // A colour code also resets styles, matching vanilla behaviour.
      color = COLORS[code]
      active.clear()
      obfuscated = false
    } else if (code === 'k') {
      obfuscated = true
    } else if (STYLES[code]) {
      active.add(code)
    }
  }

  flush()
  return out
}

module.exports = { toHtml, strip, hasCodes, escapeHtml, COLORS }
