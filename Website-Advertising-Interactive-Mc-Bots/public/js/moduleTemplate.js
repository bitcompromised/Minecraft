/* The skeleton a new module starts from.
 *
 * Prefilled into the code box on the upload form (and offered as a reset in
 * the update form), so the first thing an author sees is a file that already
 * satisfies the contract src/moduleValidator.js checks for: it parses, and it
 * exports an object with an onLoad. Filling in the blanks is a much better
 * starting point than an empty box and a link to the docs.
 *
 * Kept deliberately minimal - the demo modules in the marketplace are the
 * place to go for worked examples. Exposed as window.MODULE_TEMPLATE.
 */
window.MODULE_TEMPLATE = `module.exports = {
  name: 'My Module',

  // Called once when someone loads this module onto a running bot.
  //
  // \`bot\` is a sandboxed proxy for the mineflayer bot: every property read
  // and method call crosses a thread boundary, so everything on it is a
  // Promise - write \`await bot.entity.position\`, not \`bot.entity.position\`.
  async onLoad(bot, api) {
    api.log('My Module loaded.')

    // Subscribe to bot events through api.on, not bot.on - listener
    // functions can't cross into the sandbox.
    this.onChat = async (username, message) => {
      if (username === await bot.username) return
      // ...
    }
    api.on('chat', this.onChat)
  },

  // Undo here exactly what onLoad set up: timers, intervals, listeners.
  async onUnload(bot, api) {
    api.off('chat', this.onChat)
    api.log('My Module stopped.')
  },
}
`
