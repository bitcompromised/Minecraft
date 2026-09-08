// Demo: Chat Commands
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
        return `I am at ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}.`
      },

      async health() {
        const health = await bot.health
        const food = await bot.food
        return `Health ${Math.round(health)}/20, food ${Math.round(food)}/20.`
      },

      async players() {
        // bot.players is an object keyed by username.
        const players = await bot.players
        const names = Object.keys(players || {}).filter((n) => n !== this.selfName)
        if (names.length === 0) return 'Nobody else is online.'
        return `Online: ${names.join(', ')}`
      },
    }

    this.onChat = async (username, message) => {
      // Never react to our own chat - that is how feedback loops start.
      if (!username || username === this.selfName) return
      if (typeof message !== 'string' || !message.startsWith(PREFIX)) return

      const name = message.slice(PREFIX.length).trim().split(/\s+/)[0].toLowerCase()
      const handler = commands[name]
      if (!handler) return

      try {
        const reply = await handler.call(this)
        await bot.chat(reply)
      } catch (err) {
        api.log(`Command "${name}" failed: ${err.message}`)
      }
    }

    api.on('chat', this.onChat)
    api.log(`Chat Commands ready - try ${PREFIX}here, ${PREFIX}health, or ${PREFIX}players.`)
  },

  async onUnload(bot, api) {
    api.off('chat', this.onChat)
    api.log('Chat Commands stopped.')
  },
}
