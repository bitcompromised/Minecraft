// Coin Flip Bot (cfspoof)
//
// Port of Commands/CfSpoof.mjs from bitcompromised/mineflayer.
//
// Plays the server's /cf coinflip on a martingale-style ladder: reset the
// stake after a win, raise it after a loss, with bigger step-ups at
// particular losing streaks. It watches chat for the result line, updates
// the ladder, waits a randomised beat, and stakes again.
//
// Despite the name there is no spoofing in it - the upstream file is a
// betting strategy and nothing more. The name is kept so it lines up with
// the command it came from.
//
// The ladder below is upstream's, step for step, including the odd-looking
// random top-ups (they exist so every stake is a slightly different number
// rather than a clean doubling sequence). What has changed is how it stops.
// Upstream's safety checks were four `throw new Error(...)` calls in the
// middle of a chat handler, which in this sandbox would be caught, logged,
// and then completely ignored - the bot would keep betting. They are proper
// stop conditions here: stopLoss, target, maxBet and maxGames, each of
// which switches the module off and says why.
//
// This is gambling automation with a doubling ladder. A doubling ladder
// does not beat a coinflip: the losing streak that breaks it is not
// unlikely, it is scheduled. Set a stop-loss you are willing to lose before
// you enable this.
//
// Commands:
//
//   /cfs                      toggle on/off
//   /cfs on | off
//   /cfs bet <amount>         set the next stake
//   /cfs stoploss <amount|off>   stop once down this much
//   /cfs target <amount|off>     stop once up this much
//   /cfs maxbet <amount|off>     stop rather than stake more than this
//   /cfs maxgames <n|off>        stop after n games
//   /cfs delay <x> <s|m> | delay <min> <max> <unit>   pause between bets
//   /cfs command <text>       how a bet is placed ({amount}, {side})
//   /cfs reset                zero the profit and streak counters
//   /cfs owner add|remove|list [name]
//   /cfs status | help
//
// Amounts accept 500b, 1.5t, 2,000,000 and 15000000 alike.

// ---- defaults ------------------------------------------------------------
//
// Edit these before uploading. Every one can also be changed at runtime with
// the commands above - though runtime changes live in the module's memory
// and are gone the moment it is unloaded.

const DEFAULTS = {
  // Usernames allowed to run commands. Empty means anyone may.
  owners: [],

  // Deliberately off by default.
  enabled: false,

  // How a bet is placed. {amount} and {side} are substituted.
  command: '/cf {amount} {side}',

  // Pause between the result and the next stake.
  minRebet: 4000,
  maxRebet: 45000,

  // Stop conditions. 0 disables a check.
  stopLoss: 500e9,
  target: 1e12,
  maxBet: 2.5e12,
  maxGames: 0,
}

// The result line. RESULT_PATTERN decides that a message is a coinflip
// result at all; WIN_PATTERN decides whether it was a win. Not
// runtime-editable: a regex typed into chat is a good way to make the bot
// stake forever without ever seeing a result.
const RESULT_PATTERN = /you\s+(won|lost).*your bet against/i
const WIN_PATTERN = /you\s+won/i
const OPPONENT_PATTERN = /against\s+(\S+)/i

// ---- the ladder ----------------------------------------------------------

// Upstream's rzx(): the random fractions that keep stakes from being round
// numbers.
function rzx(bucket) {
  switch (bucket) {
    case 1: return 0.25
    case 2: return 0.3
    case 3: return 0.5
    default: return random(25, 50) / 100
  }
}

function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// The stake to fall back to after a win.
function freshBet() {
  return (random(2, 5) * (random(0, 1) ? 1e5 : random(0, 1) ? 1e6 : 1e7)) * rzx(4)
}

// The opening stake, which upstream built slightly differently again.
function openingBet() {
  return (random(1, 5) * (random(0, 1) ? 1e6 : 1e7)) + (1e7 * rzx(random(1, 3)))
}

// Given the stake that just lost, the losing streak and the win rate so
// far, returns the next stake plus a description of how it got there.
function nextBetAfterLoss(bet, loseStreak, winRate) {
  // A long streak with a bad win rate is the "something is wrong" branch:
  // step up hard and add a flat lump on top.
  if (loseStreak >= 10 && winRate < 44) {
    return { bet: bet * 2.25 + 2.5e12, mult: 2.25, extra: 2.5e12 }
  }
  if (loseStreak === 4) {
    const extra = random(1, 4) * 1e8 + 1e8 * rzx(random(1, 4))
    return { bet: bet * 2.5 + extra, mult: 2.5, extra }
  }
  if (loseStreak === 5) {
    const extra = random(1, 2) * 1e9 + 1e9 * rzx(random(1, 4))
    return { bet: bet * 2.5 + extra, mult: 2.5, extra }
  }
  if (loseStreak === 6) {
    const extra = random(1, 2) * 1e9 + 1e9 * rzx(random(1, 4))
    return { bet: bet * 2.25 + extra, mult: 2.25, extra }
  }
  // Below the ceiling the multiplier is itself randomised; above it, a flat
  // 2.25 - a randomised jump on a stake that size gets silly fast.
  if (bet < 2e12) {
    const mult = random(0, 1) ? random(2, 3) : 2 + rzx(random(1, 3))
    return { bet: bet * mult, mult, extra: 0 }
  }
  return { bet: bet * 2.25, mult: 2.25, extra: 0 }
}

// ---- command plumbing ----------------------------------------------------
//
// Commands are '/'-prefixed, which changes how they have to reach the bot: a
// '/' line typed in game goes to the server as a command, not into public
// chat, so nobody's public message will ever carry one. Two channels do
// work:
//
//   * a whisper - /msg <bot> /cfs status - which arrives verbatim;
//   * the panel's chat box, which hands what you type to loaded modules
//     as '@panel'. A line matching a command this module declares below
//     is handled here and is not passed on to the server, so it draws no
//     "Unknown command" reply.

const PREFIX = '/'
const NAMES = ['cfs', 'cfspoof', 'cfboost']
const PANEL_SENDER = '@panel'

// Shown next to this module's commands in the panel's chat box.
const DESCRIPTION = "Play the server coinflip on a martingale ladder."

// Splits "/cfs stoploss 500b" into { sub: 'stoploss', args: ['500b'] }.
// `rest` keeps the original casing and spacing, which is what a command
// template needs.
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

function onOff(args) {
  const word = (args[0] || '').toLowerCase()
  if (['on', 'true', 'yes', 'enable', 'enabled'].includes(word)) return true
  if (['off', 'false', 'no', 'disable', 'disabled', '0', 'none'].includes(word)) return false
  return null
}

// ---- helpers -------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stripCodes(text) {
  return String(text == null ? '' : text).replace(/§[0-9a-fk-or]/gi, '')
}

// Chat components arrive as plain data - prismarine-chat's toString() does
// not survive the sandbox boundary.
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

const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }

// Accepts what anyone would actually type: 500b, 1.5t, 2,000,000, 15000000.
function parseMoney(text) {
  const match = /^(\d[\d,]*(?:\.\d+)?)\s*([kmbt])?$/i.exec(String(text || '').trim())
  if (!match) return null
  const amount = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  const suffix = match[2] && SUFFIXES[match[2].toLowerCase()]
  return suffix ? amount * suffix : amount
}

function formatMoney(amount) {
  if (!Number.isFinite(amount)) return String(amount)
  const sign = amount < 0 ? '-' : ''
  const size = Math.abs(amount)
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [unit, tag] of units) {
    if (size >= unit) return `${sign}${(size / unit).toFixed(2)}${tag}`
  }
  return `${sign}${Math.round(size)}`
}

function percent(part, total) {
  if (!total) return '0.0'
  return (Math.floor((part / total) * 1000) / 10).toFixed(1)
}

// ---- module --------------------------------------------------------------

module.exports = {
  name: 'Coin Flip Bot',

  async onLoad(bot, api) {
    this.selfName = await bot.username
    this.settings = { ...DEFAULTS, owners: [...DEFAULTS.owners] }
    this.enabled = false
    this.pending = false

    this.state = {
      bet: openingBet(),
      profit: 0,
      wins: 0,
      losses: 0,
      winStreak: 0,
      loseStreak: 0,
      // Last 100 results, newest last - used only for reporting.
      history: [],
    }

    this.stop = (reason, reply) => {
      const say = reply || ((text) => api.log(text))
      if (!this.enabled) return
      this.enabled = false
      say(`Stopped: ${reason}. Profit ${formatMoney(this.state.profit)} over ${this.state.wins + this.state.losses} games.`)
    }

    this.status = () => {
      const s = this.state
      const games = s.wins + s.losses
      const last50 = s.history.slice(-50)
      return `profit ${formatMoney(s.profit)} | ${games} games | win rate ${percent(s.wins, games)}%`
        + (last50.length === 50 ? ` | last 50 ${percent(last50.filter(Boolean).length, 50)}%` : '')
        + ` | streak ${s.loseStreak ? `-${s.loseStreak}` : `+${s.winStreak}`}`
        + ` | next stake ${formatMoney(s.bet)}`
    }

    // Checked before every stake, so a run always ends between bets rather
    // than halfway through one.
    this.checkLimits = () => {
      const s = this.state
      const limits = this.settings
      if (limits.stopLoss > 0 && s.profit <= -limits.stopLoss) {
        this.stop(`down ${formatMoney(-s.profit)}, past the ${formatMoney(limits.stopLoss)} stop-loss`)
        return false
      }
      if (limits.target > 0 && s.profit >= limits.target) {
        this.stop(`up ${formatMoney(s.profit)}, past the ${formatMoney(limits.target)} target`)
        return false
      }
      if (limits.maxBet > 0 && s.bet > limits.maxBet) {
        this.stop(`next stake ${formatMoney(s.bet)} is over the ${formatMoney(limits.maxBet)} ceiling`)
        return false
      }
      if (limits.maxGames > 0 && s.wins + s.losses >= limits.maxGames) {
        this.stop(`played ${limits.maxGames} games`)
        return false
      }
      return true
    }

    this.placeBet = async () => {
      if (!this.enabled || this.pending) return
      if (!this.checkLimits()) return

      this.pending = true
      const amount = Math.ceil(this.state.bet)
      const side = random(0, 100) > 50 ? 'heads' : 'tails'
      const command = this.settings.command.replace('{amount}', String(amount)).replace('{side}', side)

      try {
        await bot.chat(command)
        api.log(`Staked ${formatMoney(amount)} on ${side}.`)
      } catch (err) {
        // The stake never went out, so nothing is owed - let the next
        // result or toggle try again.
        this.pending = false
        api.log(`Could not place bet: ${err.message}`)
      }
    }

    this.onMessage = async (jsonMsg) => {
      if (!this.enabled) return
      const text = plainText(jsonMsg)
      if (!RESULT_PATTERN.test(text)) return

      // The stake that this result settles.
      const staked = this.state.bet
      this.pending = false

      const won = WIN_PATTERN.test(text)
      const opponentMatch = OPPONENT_PATTERN.exec(text)
      const opponent = opponentMatch ? opponentMatch[1] : 'someone'
      const s = this.state

      s.history.push(won ? 1 : 0)
      if (s.history.length > 100) s.history.shift()

      if (won) {
        s.wins += 1
        s.profit += staked
        s.winStreak += 1
        s.loseStreak = 0
        // A win resets the ladder to a fresh small stake - that is the whole
        // point of it.
        s.bet = freshBet()
        api.log(`Won ${formatMoney(staked)} against ${opponent}. ${this.status()}`)
      } else {
        s.losses += 1
        s.profit -= staked
        s.winStreak = 0
        s.loseStreak += 1

        const games = s.wins + s.losses
        const winRate = games ? (s.wins / games) * 100 : 0
        const next = nextBetAfterLoss(staked, s.loseStreak, winRate)
        s.bet = next.bet
        api.log(
          `Lost ${formatMoney(staked)} to ${opponent} (streak ${s.loseStreak}, `
          + `next ${formatMoney(next.bet)} = x${next.mult}${next.extra ? ` + ${formatMoney(next.extra)}` : ''}). `
          + this.status(),
        )
      }

      await sleep(random(this.settings.minRebet, this.settings.maxRebet))
      await this.placeBet()
    }

    this.setEnabled = async (value, reply) => {
      this.enabled = value
      reply(`Coin Flip Bot ${this.enabled ? 'on' : 'off'}. ${this.status()}`)
      if (this.enabled) await this.placeBet()
    }

    // The four stop conditions all read and write the same way, so they
    // share one implementation - "off" clears the check, an amount sets it.
    this.limitCommand = (key, label, args, reply, asCount) => {
      const current = this.settings[key]
      if (onOff(args) === false) {
        this.settings[key] = 0
        return reply(`${label} off.`)
      }
      const value = asCount ? Number(args[0]) : parseMoney(args[0])
      if (value == null || !Number.isFinite(value) || value <= 0) {
        return reply(`${label} is ${current ? (asCount ? current : formatMoney(current)) : 'off'}. Usage: /${NAMES[0]} ${key.toLowerCase()} <${asCount ? 'n' : 'amount'}|off>`)
      }
      this.settings[key] = asCount ? Math.round(value) : value
      reply(`${label} set to ${asCount ? this.settings[key] : formatMoney(this.settings[key])}.`)
    }

    this.handlers = {
      on: {
        usage: 'on',
        help: 'Start betting.',
        run: (args, reply) => this.setEnabled(true, reply),
      },
      off: {
        usage: 'off',
        help: 'Stop betting.',
        run: (args, reply) => this.setEnabled(false, reply),
      },
      bet: {
        usage: 'bet <amount>',
        help: 'Set the next stake.',
        run: (args, reply) => {
          const value = parseMoney(args[0])
          if (value == null || value <= 0) return reply(`Next stake is ${formatMoney(this.state.bet)}. Usage: /${NAMES[0]} bet <amount>`)
          this.state.bet = value
          reply(`Next stake ${formatMoney(value)}.`)
        },
      },
      stoploss: {
        usage: 'stoploss <amount|off>',
        help: 'Stop once down this much.',
        run: (args, reply) => this.limitCommand('stopLoss', 'Stop-loss', args, reply, false),
      },
      target: {
        usage: 'target <amount|off>',
        help: 'Stop once up this much.',
        run: (args, reply) => this.limitCommand('target', 'Target', args, reply, false),
      },
      maxbet: {
        usage: 'maxbet <amount|off>',
        help: 'Stop rather than stake more than this.',
        run: (args, reply) => this.limitCommand('maxBet', 'Max bet', args, reply, false),
      },
      maxgames: {
        usage: 'maxgames <n|off>',
        help: 'Stop after n games.',
        run: (args, reply) => this.limitCommand('maxGames', 'Max games', args, reply, true),
      },
      delay: {
        usage: 'delay <x> <s|m> | delay <min> <max> <unit>',
        help: 'Pause between a result and the next stake.',
        run: (args, reply) => {
          const range = parseDurationRange(args, 's')
          if (!range) return reply(`Usage: /${NAMES[0]} delay <x> <s|m>  or  /${NAMES[0]} delay <min> <max> <unit>`)
          this.settings.minRebet = range.min
          this.settings.maxRebet = range.max
          reply(`Rebet delay ${formatRange(range.min, range.max)}.`)
        },
      },
      command: {
        usage: 'command <text>',
        help: 'How a bet is placed. {amount} and {side} are substituted.',
        run: (args, reply, rest) => {
          if (!rest) return reply(`Command is "${this.settings.command}". Usage: /${NAMES[0]} command </cf {amount} {side}>`)
          if (!rest.includes('{amount}')) return reply('The template needs {amount} in it, or every bet is the same size.')
          this.settings.command = rest
          reply(`Bets will be placed as "${rest}".`)
        },
      },
      reset: {
        usage: 'reset',
        help: 'Zero the profit and streak counters.',
        run: (args, reply) => {
          this.state.profit = 0
          this.state.wins = 0
          this.state.losses = 0
          this.state.winStreak = 0
          this.state.loseStreak = 0
          this.state.history = []
          this.state.bet = openingBet()
          reply(`Counters reset. ${this.status()}`)
        },
      },
      owner: {
        usage: 'owner add|remove|list [name]',
        help: 'Who may run these commands (empty list = anyone).',
        run: (args, reply) => this.ownerCommand(args, reply),
      },
      status: {
        usage: 'status',
        help: 'Show current settings and running totals.',
        run: (args, reply) => {
          reply(`Coin Flip Bot: ${this.enabled ? 'on' : 'off'} | ${this.status()}`)
          reply(`  stop-loss ${this.settings.stopLoss ? formatMoney(this.settings.stopLoss) : 'off'} | target ${this.settings.target ? formatMoney(this.settings.target) : 'off'} | max bet ${this.settings.maxBet ? formatMoney(this.settings.maxBet) : 'off'} | max games ${this.settings.maxGames || 'off'} | delay ${formatRange(this.settings.minRebet, this.settings.maxRebet)} | owners: ${this.settings.owners.length ? this.settings.owners.join(', ') : 'anyone'}`)
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
        if (!parsed.sub) return await this.setEnabled(!this.enabled, reply)
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

    api.on('message', this.onMessage)
    api.on('chat', this.onChat)
    api.on('whisper', this.onWhisper)

    if (this.settings.enabled) {
      this.enabled = true
      await this.placeBet()
    }

    api.log(
      `Coin Flip Bot loaded - ${this.enabled ? 'running' : 'idle'}, opening stake ${formatMoney(this.state.bet)}, `
      + `stop-loss ${this.settings.stopLoss ? formatMoney(this.settings.stopLoss) : 'none'}. Try ${PREFIX}${NAMES[0]} help.`,
    )
  },

  async onUnload(bot, api) {
    this.enabled = false
    api.off('message', this.onMessage)
    api.off('chat', this.onChat)
    api.off('whisper', this.onWhisper)
    api.log(`Coin Flip Bot stopped. ${this.status ? this.status() : ''}`)
  },
}
