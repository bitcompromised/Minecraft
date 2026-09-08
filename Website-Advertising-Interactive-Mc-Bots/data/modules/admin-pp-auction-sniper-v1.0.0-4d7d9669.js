// AH Sniper
//
// Port of Commands/AhSniper.mjs from bitcompromised/mineflayer.
//
// Re-opens the auction house on a timer, reads every listing on the page,
// and buys anything priced under a threshold - then confirms the purchase
// and collects the item out of the "Bought Items" menu.
//
// The upstream file is a single ~300-line switch: one `case` per item type,
// with the price thresholds, the enchant requirements and four copies of
// the same log line inlined into each branch. Every rule in it is preserved
// here, but as data - the RULES table below - with one matcher that walks
// it. That is the only structural change: adding an item upstream meant
// pasting another twenty-line case, and it is why two of the branches there
// buy at the wrong threshold. As a table the rules can also be listed,
// re-priced, switched off and added to at runtime, which is what the
// /ahs rules, cap, enable, disable and add subcommands do.
//
// Sandbox notes, all of which the upstream client did not have to care
// about:
//
//   * The window arrives as plain data. There is no `window.withdraw()`, so
//     buying is bot.clickWindow(slot, 0, 0) back through the proxy.
//   * An item's custom name, lore and enchants live behind prismarine-item
//     prototype getters, which do not survive the crossing. They are parsed
//     out of the raw NBT here instead.
//   * The listed price is read from the item's lore. If your server words
//     it differently, change PRICE_PATTERN - nothing else needs to move.
//
// READ THE THRESHOLDS BEFORE LOADING THIS. They are the upstream author's,
// for one specific server's economy, and a threshold that is too high on
// your server is a bot that empties your balance into bad listings as fast
// as it can click. Start disabled (it does), run /ahs rules, and watch the
// log before you turn it on.
//
// Commands:
//
//   /ahs                      toggle on/off
//   /ahs on | off
//   /ahs collect              collect bought items, then stop
//   /ahs rules                list the buy rules with their caps
//   /ahs cap <n|label> <price>        re-price a rule
//   /ahs enable <n|label> | disable <n|label>
//   /ahs add <item> <price> [name]    add a rule (cap is per item)
//   /ahs remove <n|label>     drop a rule
//   /ahs command <text>       the command that opens the AH
//   /ahs every <x> <s|m>      how often to refresh the page
//   /ahs delay <min> <max> <ms|s>     pause before each click
//   /ahs owner add|remove|list [name]
//   /ahs status | help
//
// Prices accept 500b, 1.5t, 2,000,000 and 15000000 alike.

// ---- defaults ------------------------------------------------------------
//
// Edit these before uploading. Every one can also be changed at runtime with
// the commands above - though runtime changes live in the module's memory
// and are gone the moment it is unloaded.

const DEFAULTS = {
  // Usernames allowed to run commands. Empty means anyone may.
  owners: [],

  // Deliberately off by default - see the warning above.
  enabled: false,

  // The command that opens the auction house, and how often to re-open it to
  // see new listings. Upstream used 2500ms.
  command: '/ah',
  every: 2500,

  // Human pauses between clicks. Menus that are driven instantly are the
  // easiest thing in the world for a server to flag.
  minClickDelay: 300,
  maxClickDelay: 1500,
  minCollectDelay: 1385,
  maxCollectDelay: 2425,
}

// Window titles, matched with colour codes stripped.
const AH_WINDOW = /Auction House/i
const CONFIRM_WINDOW = /Buy Item/i
const COLLECT_WINDOW = /Bought Items/i

// Listing slots on the auction page, and the slot holding the "collect
// bought items" button.
const LISTING_SLOTS = 35
const COLLECT_BUTTON_SLOT = 46

// The confirm button in the "Buy Item" window.
const CONFIRM_SLOT = 3

// Where the price is in a listing's lore.
const PRICE_PATTERN = /price[^0-9]*([0-9][0-9,.]*)\s*([kmbt])?/i

// Never buy these, whatever a rule says - upstream skipped chests because
// the AH uses them as page furniture.
const IGNORED_ITEMS = ['chest']

// ---- buy rules -----------------------------------------------------------
//
// Each rule matches one kind of listing and caps what it is worth paying:
//
//   label    what /ahs rules calls it, and what cap/enable/disable match on
//   item     item name (bot registry name, e.g. 'diamond_axe')
//   name     custom display name - exact string, array, or RegExp
//   where    extra test, given { count, enchants, info }
//   maxTotal cap on the whole listing's price
//   maxUnit  cap on price / stack count
//
// First match wins, so put the specific rules above the loose ones.

// Level of an enchant by name, or null. Enchant names come out of NBT as
// either 'minecraft:sharpness' or a numeric id (pre-1.13), so both are
// normalised before this sees them.
function lvl(enchants, name) {
  const found = enchants.find((e) => e.name === name)
  return found ? found.lvl : null
}

const GOD_PIECES = [
  'GOD BOOTS PIECE', 'GOD LEGGINGS PIECE', 'GOD CHESTPLACE PIECE',
  'GOD HELMET PIECE', 'GOD BOW PIECE',
]

const BOW_ENCHANTS = ['infinity', 'unbreaking', 'power', 'punch', 'flame']

const RULES = [
  // A "real" axe is sharpness 100, at most three enchants, and no mending.
  // The curse of vanishing marks the cheaper (untradeable) variant.
  {
    label: 'Omega Axe',
    item: 'diamond_axe',
    where: ({ enchants }) => enchants.length <= 3
      && lvl(enchants, 'sharpness') === 100
      && lvl(enchants, 'mending') === null
      && lvl(enchants, 'vanishing_curse') === null,
    maxTotal: 500e9,
  },
  {
    label: 'Omega Axe (cursed)',
    item: 'diamond_axe',
    where: ({ enchants }) => enchants.length <= 3
      && lvl(enchants, 'sharpness') === 100
      && lvl(enchants, 'mending') === null
      && lvl(enchants, 'vanishing_curse') !== null,
    maxTotal: 350e9,
  },

  { label: 'Omega Axe Piece', item: 'stick', name: 'OMEGA AXE PIECE', maxUnit: 100e9 },
  { label: 'God Piece', item: 'stick', name: GOD_PIECES, maxUnit: 1.5e9 },
  { label: 'Knockback Stick', item: 'stick', name: 'KNOCKBACK STICK', maxUnit: 9e9 },

  { label: 'Supplydrop Flare', item: 'redstone_torch', name: 'SUPPLYDROP FLARE', maxUnit: 30e9 },
  { label: 'MineNUKE', item: 'firework_star', name: 'MineNUKE', maxUnit: 6e9 },

  { label: 'Rankup Key', item: 'tripwire_hook', name: 'RANKUP CRATE KEY', maxUnit: 1e9 },
  { label: 'Vote Key', item: 'tripwire_hook', name: 'VOTE CRATE KEY', maxUnit: 5e9 },
  { label: 'Purple Key', item: 'tripwire_hook', name: 'PURPLE CRATE KEY', maxUnit: 20e9 },
  { label: 'God Key', item: 'tripwire_hook', name: 'GOD CRATE KEY', maxUnit: 40e9 },

  { label: 'Reset Crate', item: 'ender_chest', name: '*** RESET CRATE ***', maxUnit: 3.9e12 },
  { label: 'Token Pouch', item: 'ender_chest', name: 'TOKEN POUCH', maxUnit: 700e6 },

  { label: 'Extra Plot', item: 'name_tag', name: '+1 EXTRA PLOT', maxUnit: 35e9 },
  { label: 'Blast Credit', item: 'name_tag', name: 'BLAST ENCHANT CREDIT', maxUnit: 225e9 },
  { label: 'Voucher', item: 'name_tag', name: /VOUCHER/, maxUnit: 20e9 },
  { label: 'Cosmetic', item: 'name_tag', name: /EFFECT|TAG|SOUND/, maxUnit: 1e9 },

  { label: 'ScratchCard', item: 'paper', name: 'ScratchCard', maxUnit: 50e9 },
  { label: 'PvP-Mine Activator', item: 'ghast_tear', name: 'PvP-Mine Activator', maxUnit: 1.5e12 },

  {
    label: 'God Helmet',
    item: 'diamond_helmet',
    where: ({ enchants }) => lvl(enchants, 'unbreaking') >= 90,
    maxTotal: 6e9,
  },
  {
    label: 'God Chestplate',
    item: 'diamond_chestplate',
    where: ({ enchants }) => lvl(enchants, 'unbreaking') >= 90,
    maxTotal: 3.5e9,
  },
  {
    label: 'God Leggings',
    item: 'diamond_leggings',
    where: ({ enchants }) => lvl(enchants, 'unbreaking') >= 90,
    maxTotal: 2e9,
  },
  {
    label: 'God Boots',
    item: 'diamond_boots',
    where: ({ enchants }) => lvl(enchants, 'unbreaking') >= 90,
    maxTotal: 2e9,
  },

  { label: 'God Apple', item: 'enchanted_golden_apple', maxUnit: 15e6 },

  // A clean sharpness-90 blade and nothing else on it.
  {
    label: 'PGod Sword',
    item: 'diamond_sword',
    where: ({ enchants }) => enchants.length === 1 && lvl(enchants, 'sharpness') === 90,
    maxTotal: 9e9,
  },

  // Exactly the five standard bow enchants, priced by punch level.
  {
    label: 'God Bow (punch 2)',
    item: 'bow',
    where: ({ enchants }) => enchants.length === 5
      && enchants.every((e) => BOW_ENCHANTS.includes(e.name))
      && lvl(enchants, 'punch') === 2,
    maxTotal: 5e9,
  },
  {
    label: 'God Bow (punch 3)',
    item: 'bow',
    where: ({ enchants }) => enchants.length === 5
      && enchants.every((e) => BOW_ENCHANTS.includes(e.name))
      && lvl(enchants, 'punch') === 3,
    maxTotal: 173e9,
  },
]

// ---- command plumbing ----------------------------------------------------
//
// Commands are '/'-prefixed, which changes how they have to reach the bot: a
// '/' line typed in game goes to the server as a command, not into public
// chat, so nobody's public message will ever carry one. Two channels do
// work:
//
//   * a whisper - /msg <bot> /ahs status - which arrives verbatim;
//   * the panel's chat box, which hands what you type to loaded modules
//     as '@panel'. A line matching a command this module declares below
//     is handled here and is not passed on to the server, so it draws no
//     "Unknown command" reply.

const PREFIX = '/'
const NAMES = ['ahs', 'ahsnipe', 'ahsniper']
const PANEL_SENDER = '@panel'

// Shown next to this module's commands in the panel's chat box.
const DESCRIPTION = "Buy auction listings priced under a rule's cap."

// Splits "/ahs cap 3 500b" into { sub: 'cap', args: ['3', '500b'] }. `rest`
// keeps the original casing and spacing, which is what a display name needs.
function parseCommand(message) {
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  if (!trimmed.startsWith(PREFIX)) return null

  const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed.slice(PREFIX.length))
  if (!head || !NAMES.includes(head[1].toLowerCase())) return null

  const tail = (head[2] || '').trim()
  if (!tail) return { sub: '', args: [], rest: '' }

  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(tail)
  const rest = (parts[2] || '').trim()
  return { sub: parts[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest }
}

const DURATION_UNITS = { ms: 1, s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000 }

// Accepts "5 m", "5m", or a bare number in `defaultUnit`.
function parseDuration(args, defaultUnit) {
  if (!args.length) return null
  const match = /^(\d+(?:\.\d+)?)(ms|sec|min|hr|[smh])?$/i.exec(args.join(''))
  if (!match) return null
  const scale = DURATION_UNITS[(match[2] || defaultUnit).toLowerCase()]
  if (!scale) return null
  return Math.round(Number(match[1]) * scale)
}

// "<x> <unit>" is a fixed delay; "<min> <max> <unit>" is a range. Reversed
// bounds are swapped rather than rejected.
function parseDurationRange(args, defaultUnit) {
  if (args.length >= 2 && /^\d/.test(args[0]) && /^\d/.test(args[1])) {
    const unit = args[2] ? [args[2]] : []
    const min = parseDuration([args[0], ...unit], defaultUnit)
    const max = parseDuration([args[1], ...unit], defaultUnit)
    if (min == null || max == null) return null
    return min <= max ? { min, max } : { min: max, max: min }
  }
  const fixed = parseDuration(args, defaultUnit)
  return fixed == null ? null : { min: fixed, max: fixed }
}

function formatDuration(ms) {
  if (ms >= 3600000 && ms % 3600000 === 0) return `${ms / 3600000}h`
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

function formatRange(min, max) {
  return min === max ? formatDuration(min) : `${formatDuration(min)}-${formatDuration(max)}`
}

// ---- helpers -------------------------------------------------------------

function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripCodes(text) {
  return String(text == null ? '' : text).replace(/§[0-9a-fk-or]/gi, '')
}

// Window titles and chat arrive as plain component data - prismarine-chat's
// toString() is a prototype method and does not survive the boundary.
function plainText(node) {
  if (node == null) return ''
  if (typeof node === 'string') {
    const trimmed = node.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return plainText(JSON.parse(trimmed))
      } catch {
        return stripCodes(node)
      }
    }
    return stripCodes(node)
  }
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (typeof node !== 'object') return String(node)
  if (node.json) return plainText(node.json)

  let out = ''
  if (typeof node.text === 'string') out += stripCodes(node.text)
  if (typeof node[''] === 'string') out += stripCodes(node[''])
  if (Array.isArray(node.with)) out += node.with.map(plainText).join(' ')
  if (Array.isArray(node.extra)) out += node.extra.map(plainText).join('')
  return out
}

// prismarine-nbt's simplify(), inlined - the sandbox cannot require it
// unless an admin allowlists the package.
function simplifyCompound(value) {
  const out = {}
  for (const key of Object.keys(value || {})) out[key] = simplifyNbt(value[key])
  return out
}

function simplifyNbt(node) {
  if (node == null || typeof node !== 'object') return node
  if (node.type === 'compound') return simplifyCompound(node.value)
  if (node.type === 'list') {
    const list = node.value || {}
    const items = Array.isArray(list.value) ? list.value : []
    if (list.type === 'compound') return items.map(simplifyCompound)
    if (list.type === 'list') return items.map((item) => simplifyNbt({ type: 'list', value: item }))
    return items
  }
  if ('value' in node) return node.value
  return node
}

// 1.13+ stores enchants under Enchantments with namespaced string ids;
// before that it was `ench` with numeric ids, which need the registry to
// resolve. `enchantNames` is that id -> name map, read once at load.
function readEnchants(tag, enchantNames) {
  const raw = tag.Enchantments || tag.ench || tag.StoredEnchantments
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => ({
      lvl: Number(entry.lvl),
      name: typeof entry.id === 'string'
        ? entry.id.replace('minecraft:', '')
        : (enchantNames[entry.id] || null),
    }))
    .filter((entry) => entry.name)
}

const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }

// These servers write prices as "1,250,000" and as "1.25B" interchangeably,
// and so does anyone typing a cap into chat.
function parseMoney(text) {
  const match = /^(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?$/i.exec(String(text || '').trim())
  if (!match) return null
  const amount = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  const suffix = match[2] && SUFFIXES[match[2].toLowerCase()]
  return suffix ? amount * suffix : amount
}

function priceFromLore(lore) {
  for (const line of lore) {
    const match = PRICE_PATTERN.exec(line)
    if (!match) continue
    const amount = Number(match[1].replace(/,/g, ''))
    if (!Number.isFinite(amount)) continue
    const suffix = match[2] && SUFFIXES[match[2].toLowerCase()]
    return suffix ? amount * suffix : amount
  }
  return null
}

function formatMoney(amount) {
  if (!Number.isFinite(amount)) return String(amount)
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, tag] of units) {
    if (Math.abs(amount) >= size) return `${(amount / size).toFixed(2)}${tag}`
  }
  return String(Math.round(amount))
}

function sellerFromLore(lore) {
  const line = lore.find((entry) => /seller/i.test(entry))
  if (!line) return 'unknown'
  return line.replace(/.*seller[:\s]*/i, '').trim() || 'unknown'
}

function nameMatches(rule, name) {
  if (rule.name == null) return true
  if (rule.name instanceof RegExp) return rule.name.test(name)
  if (Array.isArray(rule.name)) return rule.name.includes(name)
  return rule.name === name
}

function describeRuleName(rule) {
  if (rule.name == null) return 'any'
  if (rule.name instanceof RegExp) return String(rule.name)
  if (Array.isArray(rule.name)) return rule.name.join(' / ')
  return rule.name
}

// The whole windowOpen payload is dropped if any slot's NBT fails to
// serialise, so fall back to reading the live window through the proxy.
async function readWindow(bot, fromEvent) {
  if (fromEvent && Array.isArray(fromEvent.slots)) return fromEvent
  const [title, slots] = await Promise.all([bot.currentWindow.title, bot.currentWindow.slots])
  if (!Array.isArray(slots)) return null
  return { title, slots }
}

// ---- module --------------------------------------------------------------

module.exports = {
  name: 'AH Sniper',

  async onLoad(bot, api) {
    this.selfName = await bot.username
    this.settings = { ...DEFAULTS, owners: [...DEFAULTS.owners] }
    // A working copy, so re-pricing a rule at runtime does not edit the
    // table the next load starts from.
    this.rules = RULES.map((rule) => ({ ...rule, off: false }))
    this.enabled = this.settings.enabled
    this.collecting = false
    this.busy = false
    this.bought = 0

    // Pre-1.13 NBT stores enchants by numeric id. The registry is plain
    // data, so one read gets the whole id -> name map; on newer versions the
    // ids are strings and this is never consulted.
    this.enchantNames = {}
    try {
      const enchantments = await bot.registry.enchantments
      for (const key of Object.keys(enchantments || {})) {
        const entry = enchantments[key]
        if (entry && entry.name) this.enchantNames[entry.id] = entry.name
      }
    } catch (err) {
      api.log(`Could not read the enchantment table: ${err.message}`)
    }

    // Everything a rule needs to decide, in one place.
    this.describe = (item) => {
      const tag = simplifyNbt(item.nbt) || {}
      const display = tag.display || {}
      let lore = display.Lore
      if (typeof lore === 'string') lore = [lore]
      if (!Array.isArray(lore)) lore = []
      lore = lore.map(stripCodes)

      return {
        item: item.name,
        count: item.count || 1,
        name: stripCodes(display.Name || ''),
        lore,
        price: priceFromLore(lore),
        enchants: readEnchants(tag, this.enchantNames),
      }
    }

    this.ruleFor = (listing) => {
      for (const rule of this.rules) {
        if (rule.off) continue
        if (rule.item !== listing.item) continue
        if (!nameMatches(rule, listing.name)) continue
        if (rule.where && !rule.where(listing)) continue

        const unit = listing.price / listing.count
        if (rule.maxTotal != null && listing.price > rule.maxTotal) continue
        if (rule.maxUnit != null && unit > rule.maxUnit) continue
        return rule
      }
      return null
    }

    // Rules are addressed by their number in /ahs rules, or by a
    // case-insensitive prefix of their label.
    this.findRule = (token) => {
      if (!token) return null
      const index = Number(token)
      if (Number.isInteger(index) && index >= 1 && index <= this.rules.length) {
        return { rule: this.rules[index - 1], index: index - 1 }
      }
      const needle = String(token).toLowerCase()
      const found = this.rules.findIndex((rule) => rule.label.toLowerCase().startsWith(needle))
      return found === -1 ? null : { rule: this.rules[found], index: found }
    }

    this.ruleLine = (rule, index) => {
      const cap = rule.maxTotal != null
        ? `${formatMoney(rule.maxTotal)} total`
        : `${formatMoney(rule.maxUnit)} each`
      return `  ${index + 1}. ${rule.off ? '[off] ' : ''}${rule.label} - ${rule.item} "${describeRuleName(rule)}" under ${cap}${rule.where ? ' (+enchant test)' : ''}`
    }

    this.click = async (slot) => {
      await sleep(random(this.settings.minClickDelay, this.settings.maxClickDelay))
      await bot.clickWindow(slot, 0, 0)
    }

    this.handleAuctionPage = async (slots) => {
      if (this.collecting) {
        await this.click(COLLECT_BUTTON_SLOT)
        return
      }

      for (let i = 0; i < LISTING_SLOTS; i++) {
        const item = slots[i]
        if (!item || !item.name) continue
        if (IGNORED_ITEMS.includes(item.name)) continue

        const listing = this.describe(item)
        // A slot with no lore, no custom name or no price is furniture, not
        // a listing.
        if (!listing.name || listing.lore.length === 0 || listing.price == null) continue

        const rule = this.ruleFor(listing)
        if (!rule) continue

        api.log(
          `Buying ${listing.count}x ${listing.item} [${listing.name}] as "${rule.label}" `
          + `for ${formatMoney(listing.price)} (${formatMoney(listing.price / listing.count)}/ea) `
          + `from ${sellerFromLore(listing.lore)}.`,
        )
        await this.click(i)
        return
      }
    }

    this.handleCollectPage = async (slots) => {
      // Empty means everything bought has been collected.
      if (!slots[0]) {
        this.collecting = false
        api.log('Nothing left to collect.')
        return
      }

      const item = slots[0]
      const listing = this.describe(item)
      api.log(`Collecting ${item.count}x ${item.name}${listing.name ? ` [${listing.name}]` : ''}.`)
      await sleep(random(this.settings.minCollectDelay, this.settings.maxCollectDelay))
      await bot.clickWindow(0, 0, 0)

      // Re-opening the menu is what advances to the next item. The window is
      // deliberately not closed through bot.closeWindow() - that would need
      // the real Window object, and handing it a reconstructed one writes
      // plain data into the bot's own inventory.
      if (this.collecting || this.enabled) {
        await sleep(random(this.settings.minCollectDelay, this.settings.maxCollectDelay))
        await bot.chat(this.settings.command)
      }
    }

    this.onWindowOpen = async (windowFromEvent) => {
      if (!this.enabled && !this.collecting) return
      // One menu at a time: a refresh landing mid-purchase would click the
      // confirm button of a window that has already moved on.
      if (this.busy) return
      this.busy = true

      try {
        const window = await readWindow(bot, windowFromEvent)
        if (!window) return
        const title = plainText(window.title)

        if (AH_WINDOW.test(title)) {
          await this.handleAuctionPage(window.slots)
        } else if (CONFIRM_WINDOW.test(title)) {
          await this.click(CONFIRM_SLOT)
          this.bought += 1
        } else if (COLLECT_WINDOW.test(title)) {
          await this.handleCollectPage(window.slots)
        }
      } catch (err) {
        api.log(`AH menu failed: ${err.message}`)
      } finally {
        this.busy = false
      }
    }

    this.tick = async () => {
      if (!this.enabled || this.busy) return
      try {
        await bot.chat(this.settings.command)
      } catch (err) {
        api.log(`Could not send ${this.settings.command}: ${err.message}`)
      }
    }

    this.rescheduleTicks = () => {
      clearInterval(this.timer)
      this.timer = setInterval(() => { this.tick() }, this.settings.every)
    }

    this.setEnabled = (value, reply) => {
      this.enabled = value
      const active = this.rules.filter((rule) => !rule.off).length
      reply(`AH Sniper ${this.enabled ? 'on' : 'off'} - ${active}/${this.rules.length} rules active, ${this.bought} bought.`)
      if (this.enabled) this.tick()
    }

    this.handlers = {
      on: {
        usage: 'on',
        help: 'Start sniping.',
        run: (args, reply) => this.setEnabled(true, reply),
      },
      off: {
        usage: 'off',
        help: 'Stop.',
        run: (args, reply) => this.setEnabled(false, reply),
      },
      collect: {
        usage: 'collect',
        help: 'Collect bought items, then stop.',
        run: async (args, reply) => {
          this.enabled = false
          this.collecting = true
          reply('Collecting bought items.')
          await bot.chat(this.settings.command)
        },
      },
      rules: {
        usage: 'rules',
        help: 'List the buy rules with their caps.',
        run: (args, reply) => {
          reply(`${this.rules.length} rules (${this.rules.filter((r) => !r.off).length} active):`)
          this.rules.forEach((rule, index) => reply(this.ruleLine(rule, index)))
        },
      },
      cap: {
        usage: 'cap <n|label> <price>',
        help: 'Re-price a rule. Accepts 500b, 1.5t, 2,000,000.',
        run: (args, reply) => {
          const found = this.findRule(args[0])
          if (!found) return reply(`Usage: /${NAMES[0]} cap <n|label> <price> - see /${NAMES[0]} rules`)
          const price = parseMoney(args[1])
          if (price == null || price <= 0) return reply(`"${args[1]}" is not a price. Try 500b, 1.5t or 2000000.`)

          // Whichever kind of cap the rule already uses stays that kind -
          // silently switching a per-item cap to a whole-stack one would
          // change what it buys by a factor of the stack size.
          if (found.rule.maxTotal != null) found.rule.maxTotal = price
          else found.rule.maxUnit = price
          reply(this.ruleLine(found.rule, found.index).trim())
        },
      },
      enable: {
        usage: 'enable <n|label>',
        help: 'Turn a rule back on.',
        run: (args, reply) => {
          const found = this.findRule(args[0])
          if (!found) return reply(`Usage: /${NAMES[0]} enable <n|label> - see /${NAMES[0]} rules`)
          found.rule.off = false
          reply(`Enabled "${found.rule.label}".`)
        },
      },
      disable: {
        usage: 'disable <n|label>',
        help: 'Stop buying on a rule without removing it.',
        run: (args, reply) => {
          const found = this.findRule(args[0])
          if (!found) return reply(`Usage: /${NAMES[0]} disable <n|label> - see /${NAMES[0]} rules`)
          found.rule.off = true
          reply(`Disabled "${found.rule.label}".`)
        },
      },
      add: {
        usage: 'add <item> <price> [name]',
        help: 'Add a rule. Price is per item; name is the display name.',
        run: (args, reply) => {
          const item = args[0]
          const price = parseMoney(args[1])
          if (!item || price == null || price <= 0) {
            return reply(`Usage: /${NAMES[0]} add <item_name> <price> [display name] - e.g. /${NAMES[0]} add tripwire_hook 2b GOD CRATE KEY`)
          }
          const name = args.slice(2).join(' ').trim()
          const rule = {
            label: name || item,
            item,
            name: name || null,
            maxUnit: price,
            off: false,
            added: true,
          }
          // New rules go first: a hand-typed rule is almost always meant to
          // win over the general one it was typed to override.
          this.rules.unshift(rule)
          reply(this.ruleLine(rule, 0).trim())
        },
      },
      remove: {
        usage: 'remove <n|label>',
        help: 'Drop a rule entirely.',
        run: (args, reply) => {
          const found = this.findRule(args[0])
          if (!found) return reply(`Usage: /${NAMES[0]} remove <n|label> - see /${NAMES[0]} rules`)
          this.rules.splice(found.index, 1)
          reply(`Removed "${found.rule.label}" - ${this.rules.length} rules left.`)
        },
      },
      command: {
        usage: 'command <text>',
        help: 'The command that opens the auction house.',
        run: (args, reply, rest) => {
          if (!rest) return reply(`Command is ${this.settings.command}. Usage: /${NAMES[0]} command </ah>`)
          this.settings.command = rest
          reply(`Will send ${rest}.`)
        },
      },
      every: {
        usage: 'every <x> <s|m>',
        help: 'How often to refresh the page.',
        run: (args, reply) => {
          const value = parseDuration(args, 's')
          if (value == null) return reply(`Usage: /${NAMES[0]} every <x> <s|m>`)
          if (value < 1000) return reply('Refusing to refresh faster than once a second.')
          this.settings.every = value
          this.rescheduleTicks()
          reply(`Refreshing every ${formatDuration(value)}.`)
        },
      },
      delay: {
        usage: 'delay <x> <ms|s> | delay <min> <max> <unit>',
        help: 'Pause before each menu click.',
        run: (args, reply) => {
          const range = parseDurationRange(args, 'ms')
          if (!range) return reply(`Usage: /${NAMES[0]} delay <x> <ms|s>  or  /${NAMES[0]} delay <min> <max> <unit>`)
          this.settings.minClickDelay = range.min
          this.settings.maxClickDelay = range.max
          reply(`Click delay ${formatRange(range.min, range.max)}.`)
        },
      },
      owner: {
        usage: 'owner add|remove|list [name]',
        help: 'Who may run these commands (empty list = anyone).',
        run: (args, reply) => this.ownerCommand(args, reply),
      },
      status: {
        usage: 'status',
        help: 'Show current settings.',
        run: (args, reply) => {
          reply(`AH Sniper: ${this.enabled ? 'on' : 'off'}${this.collecting ? ' (collecting)' : ''} | ${this.bought} bought | ${this.rules.filter((r) => !r.off).length}/${this.rules.length} rules active | ${this.settings.command} every ${formatDuration(this.settings.every)} | click delay ${formatRange(this.settings.minClickDelay, this.settings.maxClickDelay)} | owners: ${this.settings.owners.length ? this.settings.owners.join(', ') : 'anyone'}`)
        },
      },
      help: {
        usage: 'help',
        help: 'List these commands.',
        run: (args, reply) => this.helpCommand(reply),
      },
    }


    // Published to the panel, and read by the host after onLoad: the same
    // table without the handlers. The chat box builds its completion list
    // from this, and the bot uses it to tell a module command apart from a
    // real server command - so there is one source of truth for both, and
    // adding a subcommand above is all it takes to have it offered.
    this.commands = [{
      name: NAMES[0],
      aliases: NAMES.slice(1),
      usage: PREFIX + NAMES[0],
      description: DESCRIPTION,
      subcommands: Object.keys(this.handlers).map((name) => ({
        name,
        usage: PREFIX + NAMES[0] + ' ' + this.handlers[name].usage,
        description: this.handlers[name].help,
      })),
    }]
    this.ownerCommand = (args, reply) => {
      const action = (args[0] || 'list').toLowerCase()
      const name = args[1]
      if (action === 'list') {
        return reply(`Owners: ${this.settings.owners.length ? this.settings.owners.join(', ') : 'anyone'}`)
      }
      if (!name) return reply(`Usage: /${NAMES[0]} owner ${action} <name>`)
      if (action === 'add') {
        if (this.settings.owners.includes(name)) return reply(`${name} is already an owner.`)
        this.settings.owners.push(name)
        return reply(`Added owner ${name}. Only ${this.settings.owners.join(', ')} may run these commands now.`)
      }
      if (action === 'remove') {
        const index = this.settings.owners.indexOf(name)
        if (index === -1) return reply(`${name} is not an owner.`)
        this.settings.owners.splice(index, 1)
        return reply(this.settings.owners.length ? `Removed ${name}.` : `Removed ${name} - anyone may run these commands now.`)
      }
      return reply(`Usage: /${NAMES[0]} owner add|remove|list [name]`)
    }

    this.helpCommand = (reply) => {
      reply(`/${NAMES[0]} - ${Object.keys(this.handlers).length} subcommands (aliases: ${NAMES.map((n) => PREFIX + n).join(', ')})`)
      for (const entry of Object.values(this.handlers)) reply(`  ${PREFIX}${NAMES[0]} ${entry.usage} - ${entry.help}`)
      reply(`  ${PREFIX}${NAMES[0]} - toggle on/off`)
    }

    this.allowed = (username) => {
      if (username === PANEL_SENDER) return true
      if (this.settings.owners.length === 0) return true
      return this.settings.owners.includes(username)
    }

    this.dispatch = async (source, username, message) => {
      // The bot's own public chat is never a command; a whisper from itself
      // is, because that is how the panel can reach a module through the
      // server.
      if (!username || (source === 'chat' && username === this.selfName)) return

      const parsed = parseCommand(message)
      if (!parsed) return
      if (!this.allowed(username)) return

      const reply = (text) => {
        api.log(text)
        if (source === 'whisper' && username !== PANEL_SENDER && username !== this.selfName) {
          bot.whisper(username, text).catch(() => {})
        }
      }

      try {
        if (!parsed.sub) return this.setEnabled(!this.enabled, reply)
        const entry = this.handlers[parsed.sub]
        if (!entry) {
          reply(`Unknown subcommand "${parsed.sub}".`)
          return this.helpCommand(reply)
        }
        await entry.run(parsed.args, reply, parsed.rest)
      } catch (err) {
        api.log(`Command failed: ${err.message}`)
      }
    }

    this.onChat = (username, message) => this.dispatch('chat', username, message)
    this.onWhisper = (username, message) => this.dispatch('whisper', username, message)

    api.on('windowOpen', this.onWindowOpen)
    api.on('chat', this.onChat)
    api.on('whisper', this.onWhisper)
    this.rescheduleTicks()

    if (this.enabled) this.tick()
    api.log(
      `AH Sniper loaded with ${this.rules.length} buy rules - ${this.enabled ? 'sniping' : 'idle'}. `
      + `Try ${PREFIX}${NAMES[0]} rules, then ${PREFIX}${NAMES[0]} on.`,
    )
  },

  async onUnload(bot, api) {
    this.enabled = false
    this.collecting = false
    clearInterval(this.timer)
    api.off('windowOpen', this.onWindowOpen)
    api.off('chat', this.onChat)
    api.off('whisper', this.onWhisper)
    api.log(`AH Sniper stopped (${this.bought} bought).`)
  },
}