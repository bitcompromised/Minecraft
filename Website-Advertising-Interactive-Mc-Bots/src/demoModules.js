// The first-party demo modules seeded into the marketplace on first start
// (see bootstrapDemoModules in src/bootstrap.js).
//
// These exist to be *read*: their source is viewable by anyone, owned or
// not, so a new module author has a working reference for the sandbox API
// (async `bot` proxy, api.log, api.on) without having to buy something
// first. They're free, approved on creation, and owned by the admin account.
//
// Keep them small, correct, and heavily commented - they double as the
// living examples the Module API docs page points at. Every one of them is
// written against the real sandbox contract: `bot.*` is always a Promise,
// even for plain property reads, and events arrive via api.on, never
// bot.on. Bumping a module's source here does NOT rewrite the copy already
// on disk - change its demoKey if you need a reseed.

const DEMO_MODULES = [
  {
    demoKey: 'demo-greeter-v1',
    name: 'Demo: Greeter',
    description:
      'Says hello when a player joins and goodbye when they leave. The smallest useful module - '
      + 'shows how to subscribe to bot events with api.on and send chat through the async bot proxy.',
    fileName: 'demo-greeter.js',
    source: `// Demo: Greeter
//
// Greets players as they join and says goodbye when they leave.
//
// Two things to notice:
//   1. Events come through api.on(...), never bot.on(...) - listener
//      functions can't cross the worker-thread boundary.
//   2. Every bot.* call is async, so chat() is awaited.

module.exports = {
  name: 'Demo: Greeter',

  async onLoad(bot, api) {
    // Remember our own name so we never greet ourselves on (re)spawn.
    this.selfName = await bot.username

    this.onJoin = async (player) => {
      if (!player || player.username === this.selfName) return
      await bot.chat(\`Hello, \${player.username}!\`)
    }

    this.onLeave = async (player) => {
      if (!player || player.username === this.selfName) return
      await bot.chat(\`See you, \${player.username}.\`)
    }

    api.on('playerJoined', this.onJoin)
    api.on('playerLeft', this.onLeave)

    api.log('Greeter is watching for players.')
  },

  // Always undo in onUnload exactly what you set up in onLoad - the sandbox
  // is torn down after this returns, but leaving listeners attached while
  // the module is still live would double up on a reload.
  async onUnload(bot, api) {
    api.off('playerJoined', this.onJoin)
    api.off('playerLeft', this.onLeave)
    api.log('Greeter stopped.')
  },
}
`,
  },
  {
    demoKey: 'demo-auto-eat-v1',
    name: 'Demo: Auto Eat',
    description:
      'Eats from the bot\'s inventory whenever its food bar drops below a threshold. '
      + 'Shows reading nested bot state (inventory items, food level) across the sandbox boundary '
      + 'and driving an action from it on a timer.',
    fileName: 'demo-auto-eat.js',
    source: `// Demo: Auto Eat
//
// Keeps the bot fed. Every few seconds it checks the food bar, and if it's
// low, equips and eats the first food item in the inventory.
//
// The interesting part is how state is read: \`bot\` is a proxy, so
// \`bot.food\` and \`bot.inventory.items()\` are both awaited - there is no
// synchronous way to read a value that lives in another thread.

// Food bar (0-20) below which the bot should eat.
const HUNGRY_AT = 16
const CHECK_INTERVAL_MS = 5000

// A small, deliberately boring list - the sandbox has no minecraft-data
// import unless an admin allowlists it, so we match on name instead.
const FOOD_NAMES = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
  'cooked_chicken', 'cooked_salmon', 'bread', 'baked_potato',
  'cooked_cod', 'apple', 'carrot',
]

module.exports = {
  name: 'Demo: Auto Eat',

  async onLoad(bot, api) {
    this.eating = false

    this.tick = async () => {
      // Overlapping ticks would try to eat twice at once.
      if (this.eating) return

      const food = await bot.food
      if (typeof food !== 'number' || food >= HUNGRY_AT) return

      // items() arrives as plain data, not live Item instances - fields
      // like .name survive the boundary, methods do not.
      const items = await bot.inventory.items()
      const meal = items.find((item) => FOOD_NAMES.includes(item.name))
      if (!meal) {
        api.log('Hungry, but there is nothing edible in the inventory.')
        return
      }

      this.eating = true
      try {
        await bot.equip(meal, 'hand')
        await bot.consume()
        api.log(\`Ate \${meal.name} (food was \${food}/20).\`)
      } catch (err) {
        // Eating fails routinely - interrupted, item ran out mid-bite, and
        // so on. Log it and let the next tick try again.
        api.log(\`Could not eat: \${err.message}\`)
      } finally {
        this.eating = false
      }
    }

    this.timer = setInterval(() => { this.tick() }, CHECK_INTERVAL_MS)
    api.log(\`Auto Eat running - will eat below \${HUNGRY_AT}/20 food.\`)
  },

  async onUnload(bot, api) {
    clearInterval(this.timer)
    api.log('Auto Eat stopped.')
  },
}
`,
  },
  {
    demoKey: 'demo-chat-commands-v1',
    name: 'Demo: Chat Commands',
    description:
      'Answers !here, !health, and !players typed in chat by anyone on the server. '
      + 'A template for command-driven modules - shows parsing the chat event and replying '
      + 'with live state read back through the bot proxy.',
    fileName: 'demo-chat-commands.js',
    source: `// Demo: Chat Commands
//
// Listens for commands in server chat and replies with the bot's own state:
//
//   !here     -> the bot's current coordinates
//   !health   -> health and food
//   !players  -> who the bot can currently see online
//
// Use this as the skeleton for anything command-driven: one chat listener,
// a lookup table of handlers, and a guard so the bot never answers itself.

const PREFIX = '!'

module.exports = {
  name: 'Demo: Chat Commands',

  async onLoad(bot, api) {
    this.selfName = await bot.username

    const commands = {
      async here() {
        const pos = await bot.entity.position
        if (!pos) return 'I do not know where I am yet.'
        return \`I am at \${Math.round(pos.x)}, \${Math.round(pos.y)}, \${Math.round(pos.z)}.\`
      },

      async health() {
        const health = await bot.health
        const food = await bot.food
        return \`Health \${Math.round(health)}/20, food \${Math.round(food)}/20.\`
      },

      async players() {
        // bot.players is an object keyed by username.
        const players = await bot.players
        const names = Object.keys(players || {}).filter((n) => n !== this.selfName)
        if (names.length === 0) return 'Nobody else is online.'
        return \`Online: \${names.join(', ')}\`
      },
    }

    this.onChat = async (username, message) => {
      // Never react to our own chat - that is how feedback loops start.
      if (!username || username === this.selfName) return
      if (typeof message !== 'string' || !message.startsWith(PREFIX)) return

      const name = message.slice(PREFIX.length).trim().split(/\\s+/)[0].toLowerCase()
      const handler = commands[name]
      if (!handler) return

      try {
        const reply = await handler.call(this)
        await bot.chat(reply)
      } catch (err) {
        api.log(\`Command "\${name}" failed: \${err.message}\`)
      }
    }

    api.on('chat', this.onChat)
    api.log(\`Chat Commands ready - try \${PREFIX}here, \${PREFIX}health, or \${PREFIX}players.\`)
  },

  async onUnload(bot, api) {
    api.off('chat', this.onChat)
    api.log('Chat Commands stopped.')
  },
}
`,
  },
]

module.exports = { DEMO_MODULES }
