// Check Plots
//
// Port of Commands/CheckPlots.mjs from bitcompromised/mineflayer.
//
// Walks the list of players the bot has ever seen, teleports to each one's
// plot with /p h, scans the area for shop signs, and reports the ones
// selling anything on the want list. It is a shop-price survey: the point
// is to find out who is selling what, and for how much, without visiting
// two hundred plots by hand.
//
// How it knows a teleport worked is worth keeping: it records the bot's
// position, sends /p h, waits, and compares. If the position did not move,
// that player has no plot (or the teleport was refused) and the scan is
// skipped. No message parsing, so it does not care how the server words
// "that player has no plot".
//
// Sandbox notes:
//
//   * findBlocks({ matching }) cannot take a matcher function here -
//     functions do not survive the thread boundary - so the sign block ids
//     are looked up from the registry at load and passed as an array.
//   * Sign text does not come back as a method. block.getSignText() is gone
//     by the time a module sees the block; the text is read out of
//     block.signText (older servers) or the block entity NBT (newer ones).
//   * Positions must be passed as plain {x, y, z}; the host rebuilds them
//     into Vec3 before handing them to mineflayer.
//
// Commands:
//
//   /checkplots               scan every seen player
//   /checkplots <player>      scan one player the bot has seen
//   /checkplots run [player]  scan anyone, seen or not
//   /checkplots stop          abort after the current plot
//   /checkplots seen          how many players are on the list
//   /checkplots radius <n>    how far around each plot to look
//   /checkplots max <n>       most signs to read per plot
//   /checkplots wait <x> <s|ms>       how long to wait for a teleport
//   /checkplots delay <x> <s> | delay <min> <max> <unit>   gap between plots
//   /checkplots home <text>   the teleport command ({player} substituted)
//   /checkplots want add|remove|list [text]   keywords a sign must mention
//   /checkplots strict on|off  also require the plot owner's name on the sign
//   /checkplots announce on|off   say findings in chat as well as logging
//   /checkplots owner add|remove|list [name]
//   /checkplots status | help

// ---- defaults ------------------------------------------------------------
//
// Edit these before uploading. Every one can also be changed at runtime with
// the commands above - though runtime changes live in the module's memory
// and are gone the moment it is unloaded.

const DEFAULTS = {
  // Usernames allowed to run commands. Empty means anyone may.
  owners: [],

  // How to visit a plot. {player} is substituted.
  home: '/p h {player}',

  // How long to wait for the teleport to land before deciding it did not.
  wait: 1500,

  // Gap between plots.
  minPlotDelay: 1500,
  maxPlotDelay: 2500,

  // How far around the plot to look, and a hard cap on how many signs to
  // read per plot - each one is a separate round trip to the bot.
  radius: 80,
  maxSigns: 600,

  // A sign only counts if it mentions one of these. Upstream's list, which
  // is just "the things worth knowing the price of" on that server.
  want: [
    'Mine', 'RANKU', 'GOD C', 'PURPL', 'PLOT', 'Scrat', 'BLAST',
    'GOD H', 'GOD L', 'GOD B', 'O: x1', 'Golden A', 'TOKEN',
  ],

  // Also require the plot owner's name to appear on the sign. Upstream did
  // this, but its filter was written so that the name test only ever applied
  // to the first keyword - most signs got through regardless.
  strict: false,

  // Say findings in chat as well as logging them. Off by default: a bot that
  // broadcasts a shop survey is a bot everyone notices.
  announce: false,
}

// A sign only counts if it is a shop. Not runtime-editable: a regex typed
// into chat is a good way to make every scan come back empty.
const SHOP_PATTERN = /\[(Buy|Sell) Shop\]/i

// ---- command plumbing ----------------------------------------------------
//
// Commands are '/'-prefixed, which changes how they have to reach the bot: a
// '/' line typed in game goes to the server as a command, not into public
// chat, so nobody's public message will ever carry one. Two channels do
// work:
//
//   * a whisper - /msg <bot> /checkplots status - which arrives verbatim;
//   * the panel's chat box, which hands what you type to loaded modules
//     as '@panel'. A line matching a command this module declares below
//     is handled here and is not passed on to the server, so it draws no
//     "Unknown command" reply.

const PREFIX = '/'
const NAMES = ['checkplots', 'findshops']
const PANEL_SENDER = '@panel'

// Shown next to this module's commands in the panel's chat box.
const DESCRIPTION = "Visit players' plots and report their shop signs."

// Splits "/checkplots want add GOD KEY" into { sub: 'want', args: ['add',
// 'GOD', 'KEY'], rest: 'add GOD KEY' }. `rest` keeps the original casing,
// which matters for keywords - the sign text is matched case-sensitively.
function parseCommand(message) {
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  if (!trimmed.startsWith(PREFIX)) return null

  const head = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed.slice(PREFIX.length))
  if (!head || !NAMES.includes(head[1].toLowerCase())) return null

  const tail = (head[2] || '').trim()
  if (!tail) return { sub: '', args: [], rest: '', raw: '' }

  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(tail)
  const rest = (parts[2] || '').trim()
  // `raw` keeps the first word as typed, because for this module an
  // unrecognised subcommand is a player name and casing matters there.
  return { sub: parts[1].toLowerCase(), raw: parts[1], args: rest ? rest.split(/\s+/) : [], rest }
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

function onOff(args) {
  const word = (args[0] || '').toLowerCase()
  if (['on', 'true', 'yes', 'enable', 'enabled'].includes(word)) return true
  if (['off', 'false', 'no', 'disable', 'disabled'].includes(word)) return false
  return null
}

// Minecraft usernames, so an unrecognised subcommand can be told apart from
// a typo.
function looksLikeUsername(text) {
  return /^[A-Za-z0-9_]{3,16}$/.test(text)
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

// Sign lines are chat components, and arrive as plain data.
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

// prismarine-nbt's simplify(), inlined.
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

// The four lines of a sign, from whichever place this server version put
// them: the legacy signText array, the 1.20+ front/back text compounds, or
// the old Text1..Text4 block entity fields.
function signLines(block) {
  if (!block) return []
  if (Array.isArray(block.signText)) return block.signText.map(plainText)

  const tag = simplifyNbt(block.entity)
  if (!tag || typeof tag !== 'object') return []

  const lines = []
  for (const side of ['front_text', 'back_text']) {
    const messages = tag[side] && tag[side].messages
    if (Array.isArray(messages)) lines.push(...messages.map(plainText))
  }
  if (lines.length > 0) return lines

  return [tag.Text1, tag.Text2, tag.Text3, tag.Text4]
    .filter((line) => line != null)
    .map(plainText)
}

function samePosition(a, b) {
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.z === b.z
}

// ---- module --------------------------------------------------------------

module.exports = {
  name: 'Check Plots',

  async onLoad(bot, api) {
    this.selfName = await bot.username
    this.settings = { ...DEFAULTS, owners: [...DEFAULTS.owners], want: [...DEFAULTS.want] }
    this.running = false
    this.abort = false

    // Everyone online now, plus everyone who joins while this is loaded.
    // The bot cannot see who it has never met, so the longer it stays on,
    // the more complete a survey gets.
    const players = await bot.players
    this.seen = new Set(Object.keys(players || {}).filter((name) => name !== this.selfName))

    this.onPlayerJoined = (player) => {
      if (player && player.username && player.username !== this.selfName) {
        this.seen.add(player.username)
      }
    }

    // Sign block ids, resolved once. Names differ wildly by version
    // (sign/wall_sign, then oak_sign, oak_wall_sign, hanging signs...), so
    // match on the name rather than listing them.
    const blocksByName = await bot.registry.blocksByName
    this.signIds = Object.keys(blocksByName || {})
      .filter((name) => /sign$/.test(name) || /_sign(_|$)/.test(name))
      .map((name) => blocksByName[name].id)

    if (this.signIds.length === 0) api.log('Warning: no sign blocks in this server\'s registry - scans will find nothing.')

    this.scanHere = async (owner) => {
      const positions = await bot.findBlocks({
        matching: this.signIds,
        maxDistance: this.settings.radius,
        count: this.settings.maxSigns,
      })
      if (!Array.isArray(positions) || positions.length === 0) return []

      const shops = []
      for (const position of positions) {
        if (this.abort) break
        const block = await bot.blockAt(position, true)
        const lines = signLines(block).map(stripCodes)
        const text = lines.join(' | ').trim()
        if (!text) continue
        if (!SHOP_PATTERN.test(text)) continue
        if (!this.settings.want.some((wanted) => text.includes(wanted))) continue
        if (this.settings.strict && !text.includes(owner)) continue

        shops.push(
          text
            .replace(/\[Sell Shop\]\s*\|?\s*/i, '[S] ')
            .replace(/\[Buy Shop\]\s*\|?\s*/i, '[B] '),
        )
      }
      return shops
    }

    this.checkPlayer = async (player) => {
      const before = await bot.entity.position
      await bot.chat(this.settings.home.replace('{player}', player))
      await sleep(this.settings.wait)
      const after = await bot.entity.position

      // Did not move - no plot, or the teleport was refused.
      if (samePosition(before, after)) return null

      return this.scanHere(player)
    }

    this.run = async (only, reply) => {
      if (this.running) return reply('A scan is already running.')
      this.running = true
      this.abort = false

      const targets = only ? [only] : [...this.seen]
      reply(`Checking ${targets.length} plot${targets.length === 1 ? '' : 's'}.`)

      let found = 0
      try {
        for (let i = 0; i < targets.length; i++) {
          if (this.abort) {
            reply('Scan aborted.')
            break
          }

          const player = targets[i]
          let shops = null
          try {
            shops = await this.checkPlayer(player)
          } catch (err) {
            reply(`${player}: scan failed - ${err.message}`)
            continue
          }

          if (shops == null) {
            api.log(`${player} [${i + 1}/${targets.length}]: no plot.`)
          } else {
            found += shops.length
            api.log(`${player} [${i + 1}/${targets.length}]: ${shops.length} shop${shops.length === 1 ? '' : 's'}.`)
            for (const shop of shops) {
              reply(`  ${player}: ${shop}`)
              if (this.settings.announce) {
                // Chat has a hard length limit and a rate limit; one line at
                // a time, with a gap.
                await bot.chat(shop.slice(0, 240))
                await sleep(250)
              }
            }
          }

          await sleep(random(this.settings.minPlotDelay, this.settings.maxPlotDelay))
        }
        reply(`Done - ${found} matching shop${found === 1 ? '' : 's'} across ${targets.length} plot${targets.length === 1 ? '' : 's'}.`)
      } finally {
        this.running = false
      }
    }

    this.handlers = {
      run: {
        usage: 'run [player]',
        help: 'Scan every seen player, or one named player (seen or not).',
        run: (args, reply) => { this.run(args[0] || null, reply) },
      },
      stop: {
        usage: 'stop',
        help: 'Abort after the current plot.',
        run: (args, reply) => {
          if (!this.running) return reply('Nothing is running.')
          this.abort = true
          reply('Stopping after the current plot.')
        },
      },
      seen: {
        usage: 'seen',
        help: 'How many players are on the list.',
        run: (args, reply) => {
          const names = [...this.seen]
          reply(`${names.length} player(s) seen${names.length ? `: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ', ...' : ''}` : ''}`)
        },
      },
      radius: {
        usage: 'radius <n>',
        help: 'How far around each plot to look.',
        run: (args, reply) => {
          const value = Number(args[0])
          if (!Number.isFinite(value) || value < 1 || value > 128) return reply(`Usage: /${NAMES[0]} radius <1-128>`)
          this.settings.radius = Math.round(value)
          reply(`Scan radius ${this.settings.radius}.`)
        },
      },
      max: {
        usage: 'max <n>',
        help: 'Most signs to read per plot (each is a round trip).',
        run: (args, reply) => {
          const value = Number(args[0])
          if (!Number.isInteger(value) || value < 1) return reply(`Usage: /${NAMES[0]} max <n>`)
          this.settings.maxSigns = value
          reply(`Reading at most ${value} sign(s) per plot.`)
        },
      },
      wait: {
        usage: 'wait <x> <s|ms>',
        help: 'How long to wait for a teleport to land.',
        run: (args, reply) => {
          const value = parseDuration(args, 's')
          if (value == null) return reply(`Usage: /${NAMES[0]} wait <x> <s|ms>`)
          if (value < 250) return reply('Refusing a wait under 250ms - the teleport will not have landed.')
          this.settings.wait = value
          reply(`Waiting ${formatDuration(value)} for each teleport.`)
        },
      },
      delay: {
        usage: 'delay <x> <s> | delay <min> <max> <unit>',
        help: 'Gap between plots.',
        run: (args, reply) => {
          const range = parseDurationRange(args, 's')
          if (!range) return reply(`Usage: /${NAMES[0]} delay <x> <s>  or  /${NAMES[0]} delay <min> <max> <unit>`)
          this.settings.minPlotDelay = range.min
          this.settings.maxPlotDelay = range.max
          reply(`Plot delay ${formatRange(range.min, range.max)}.`)
        },
      },
      home: {
        usage: 'home <text>',
        help: 'The teleport command. {player} is substituted.',
        run: (args, reply, rest) => {
          if (!rest) return reply(`Home command is "${this.settings.home}". Usage: /${NAMES[0]} home </p h {player}>`)
          if (!rest.includes('{player}')) return reply('The template needs {player} in it, or every plot is the same one.')
          this.settings.home = rest
          reply(`Will teleport with "${rest}".`)
        },
      },
      want: {
        usage: 'want add|remove|list [text]',
        help: 'Keywords a sign must mention. Case-sensitive.',
        run: (args, reply, rest) => {
          const action = (args[0] || 'list').toLowerCase()
          // Everything after the action, with its original casing - keywords
          // are matched against sign text as typed.
          const keyword = rest.replace(/^\S+\s*/, '').trim()
          if (action === 'list') {
            return reply(`Wanted (${this.settings.want.length}): ${this.settings.want.join(', ') || 'nothing - every shop sign matches'}`)
          }
          if (!keyword) return reply(`Usage: /${NAMES[0]} want ${action} <text>`)
          if (action === 'add') {
            if (this.settings.want.includes(keyword)) return reply(`Already wanting "${keyword}".`)
            this.settings.want.push(keyword)
            return reply(`Added "${keyword}" - ${this.settings.want.length} keyword(s).`)
          }
          if (action === 'remove') {
            const index = this.settings.want.indexOf(keyword)
            if (index === -1) return reply(`"${keyword}" is not on the list.`)
            this.settings.want.splice(index, 1)
            return reply(this.settings.want.length
              ? `Removed "${keyword}" - ${this.settings.want.length} left.`
              : `Removed "${keyword}" - the list is empty, so no sign will match.`)
          }
          return reply(`Usage: /${NAMES[0]} want add|remove|list [text]`)
        },
      },
      strict: {
        usage: 'strict on|off',
        help: "Also require the plot owner's name on the sign.",
        run: (args, reply) => {
          const value = onOff(args)
          if (value == null) return reply(`Strict is ${this.settings.strict ? 'on' : 'off'}. Usage: /${NAMES[0]} strict on|off`)
          this.settings.strict = value
          reply(`Strict ${value ? 'on - signs must name their plot owner' : 'off'}.`)
        },
      },
      announce: {
        usage: 'announce on|off',
        help: 'Say findings in chat as well as logging them.',
        run: (args, reply) => {
          const value = onOff(args)
          if (value == null) return reply(`Announce is ${this.settings.announce ? 'on' : 'off'}. Usage: /${NAMES[0]} announce on|off`)
          this.settings.announce = value
          reply(`Announce ${value ? 'on' : 'off'}.`)
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
          reply(`Check Plots: ${this.running ? 'scanning' : 'idle'} | ${this.seen.size} seen | radius ${this.settings.radius}, max ${this.settings.maxSigns} signs | wait ${formatDuration(this.settings.wait)} | delay ${formatRange(this.settings.minPlotDelay, this.settings.maxPlotDelay)} | ${this.settings.want.length} keyword(s) | strict ${this.settings.strict ? 'on' : 'off'} | announce ${this.settings.announce ? 'on' : 'off'} | owners: ${this.settings.owners.length ? this.settings.owners.join(', ') : 'anyone'}`)
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
      reply(`  ${PREFIX}${NAMES[0]} [player] - scan everyone, or one player`)
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
        // Scans are started, not awaited: one can run for many minutes, and
        // /checkplots stop has to be able to land while it does.
        if (!parsed.sub) {
          this.run(null, reply)
          return
        }
        const entry = this.handlers[parsed.sub]
        if (entry) return await entry.run(parsed.args, reply, parsed.rest)

        // "/checkplots Steve" - anything that is not a subcommand but names
        // a player the bot has seen is one, which is how the upstream
        // command was used. Matching on the seen list rather than on "looks
        // like a username" is what keeps a mistyped subcommand from
        // silently starting a scan instead of saying it was mistyped; a
        // player the bot has never met can still be scanned explicitly with
        // /checkplots run <name>.
        if (looksLikeUsername(parsed.raw) && this.seen.has(parsed.raw)) {
          this.run(parsed.raw, reply)
          return
        }

        reply(`Unknown subcommand "${parsed.sub}".`)
        this.helpCommand(reply)
      } catch (err) {
        api.log(`Command failed: ${err.message}`)
      }
    }

    this.onChat = (username, message) => this.dispatch('chat', username, message)
    this.onWhisper = (username, message) => this.dispatch('whisper', username, message)

    api.on('chat', this.onChat)
    api.on('whisper', this.onWhisper)
    api.on('playerJoined', this.onPlayerJoined)
    api.log(`Check Plots ready - ${this.seen.size} players seen so far. Try ${PREFIX}${NAMES[0]} help.`)
  },

  async onUnload(bot, api) {
    // The loop checks this between plots, so it stops cleanly rather than
    // being cut off mid-teleport.
    this.abort = true
    api.off('chat', this.onChat)
    api.off('whisper', this.onWhisper)
    api.off('playerJoined', this.onPlayerJoined)
    api.log('Check Plots stopped.')
  },
}