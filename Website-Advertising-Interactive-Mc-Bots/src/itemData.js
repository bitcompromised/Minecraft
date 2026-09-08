const McFormat = require('./mcFormat')

// Named chat colours -> the legacy "§" code that means the same thing.
// Everything downstream of this file (mcFormat, the client's tooltips)
// speaks section-sign codes, so component-formatted text is converted into
// that one representation rather than adding a second one.
const COLOR_CODES = {
  black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3',
  dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b',
  red: 'c', light_purple: 'd', yellow: 'e', white: 'f',
}

const STYLE_CODES = {
  bold: 'l', strikethrough: 'm', underlined: 'n', italic: 'o', obfuscated: 'k',
}

// Flattens a chat component into legacy "§"-coded text.
//
// Item names and lore stopped being plain strings in 1.13: the NBT holds a
// JSON chat component per line ({"text":"Excalibur","color":"gold"}), and
// prismarine-item hands that JSON straight back. Rendering it without this
// step is what put literal {"text":...} in tooltips. Pre-1.13 servers (and
// most plugins on them) still write plain "§6Excalibur", which passes
// through here untouched.
//
// Hex colours (1.16's {"color":"#ff8800"}) have no legacy equivalent, so
// the text survives with its formatting but not that colour.
function componentToLegacy(node, inherited = '') {
  if (node == null) return ''
  if (typeof node === 'string') return inherited + node
  if (typeof node === 'number' || typeof node === 'boolean') return inherited + String(node)
  if (Array.isArray(node)) return node.map((child) => componentToLegacy(child, inherited)).join('')
  if (typeof node !== 'object') return ''

  // A prismarine-chat ChatMessage keeps the raw component on `json`.
  if (node.json) return componentToLegacy(node.json, inherited)

  let prefix = ''
  const color = typeof node.color === 'string' ? node.color.toLowerCase() : null
  if (color && COLOR_CODES[color]) prefix += `§${COLOR_CODES[color]}`
  for (const [style, code] of Object.entries(STYLE_CODES)) {
    if (node[style] === true) prefix += `§${code}`
  }

  // Codes on a parent apply to its children too, so they are carried down
  // rather than emitted once and lost at the first nested component.
  const active = inherited + prefix

  let out = ''
  if (typeof node.text === 'string') out += active + node.text
  else if (typeof node[''] === 'string') out += active + node['']
  if (Array.isArray(node.with)) out += node.with.map((child) => componentToLegacy(child, active)).join(' ')
  if (Array.isArray(node.extra)) out += node.extra.map((child) => componentToLegacy(child, active)).join('')
  return out
}

// Accepts whatever this Minecraft version puts in an item's name/lore NBT:
// a plain (possibly §-coded) string, a JSON component serialised as a
// string, or an already-parsed component object.
function normalizeMcText(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') return componentToLegacy(raw)
  if (typeof raw !== 'string') return String(raw)

  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return componentToLegacy(JSON.parse(trimmed))
    } catch {
      // Not actually JSON - a name that merely starts with a brace.
      return raw
    }
  }
  return raw
}

// Anvil-renamed items (and a lot of plugin-given gear) carry Minecraft's
// legacy "§" colour codes inside customName - "§6§lExcalibur". The raw string
// is kept for anything that needs plain text, and a pre-rendered, fully
// escaped HTML version rides alongside it so the client can show the item the
// way the server actually coloured it. See src/mcFormat.js.
function nameFields(raw) {
  const normalized = normalizeMcText(raw)
  if (typeof normalized !== 'string' || normalized.length === 0) return { text: null, html: null }
  const text = McFormat.strip(normalized)
  return {
    text: text || normalized,
    html: McFormat.hasCodes(normalized) ? McFormat.toHtml(normalized) : null,
  }
}

// The item's lore lines, in order, each in the same {text, html} shape as a
// name. Lore is where servers put prices, rarity, seller names and item
// descriptions, so an inventory that shows the name and drops the lore is
// hiding most of what the item actually is.
//
// prismarine-item exposes it as an array of lines (a single newline-joined
// string on a few older versions), each of which may be plain text or a
// chat component - normalizeMcText sorts that out per line.
function loreFields(raw) {
  let lines = raw
  if (typeof lines === 'string') lines = lines.split('\n')
  if (!Array.isArray(lines) || lines.length === 0) return undefined

  const rendered = lines
    .map((line) => nameFields(line))
    // An empty lore line is a deliberate spacer in a tooltip, so it is kept
    // as '' rather than dropped - but a line that normalized to nothing at
    // all (null) is not a line.
    .map((fields) => (fields.text === null ? { text: '', html: null } : fields))

  return rendered.length ? rendered : undefined
}

// Reading lore goes through prismarine-item's `customLore` getter, which
// simplifies the item's NBT on every access and throws on a version it has
// no deserializer for. One malformed stack must not take down the whole
// inventory payload.
function safeLore(item) {
  try {
    return loreFields(item.customLore)
  } catch {
    return undefined
  }
}

function safeEnchants(item) {
  try {
    const enchants = item.enchants
    return enchants && enchants.length ? enchants : undefined
  } catch {
    return undefined
  }
}

function serializeItem(item) {
  if (!item) return null
  const custom = nameFields(item.customName)
  return {
    slot: item.slot,
    type: item.type,
    name: item.name,
    displayName: item.displayName,
    // Plain text, codes stripped - safe for tooltips, exports, and titles.
    customName: custom.text,
    // Pre-escaped markup, or null when the name had no colour codes.
    customNameHtml: custom.html,
    // [{ text, html }, ...] in tooltip order, or undefined for a plain item.
    lore: safeLore(item),
    count: item.count,
    enchants: safeEnchants(item),
  }
}

function serializeInventory(bot) {
  return {
    slots: bot.inventory.slots.map(serializeItem),
    heldItem: serializeItem(bot.heldItem),
    quickBarSlot: bot.quickBarSlot,
  }
}

module.exports = { serializeItem, serializeInventory, nameFields, loreFields, normalizeMcText, componentToLegacy }
