// Demo: Greeter
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
      await bot.chat(`Hello, ${player.username}!`)
    }

    this.onLeave = async (player) => {
      if (!player || player.username === this.selfName) return
      await bot.chat(`See you, ${player.username}.`)
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
