// Demo: Auto Eat
//
// Keeps the bot fed. Every few seconds it checks the food bar, and if it's
// low, equips and eats the first food item in the inventory.
//
// The interesting part is how state is read: `bot` is a proxy, so
// `bot.food` and `bot.inventory.items()` are both awaited - there is no
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
        api.log(`Ate ${meal.name} (food was ${food}/20).`)
      } catch (err) {
        // Eating fails routinely - interrupted, item ran out mid-bite, and
        // so on. Log it and let the next tick try again.
        api.log(`Could not eat: ${err.message}`)
      } finally {
        this.eating = false
      }
    }

    this.timer = setInterval(() => { this.tick() }, CHECK_INTERVAL_MS)
    api.log(`Auto Eat running - will eat below ${HUNGRY_AT}/20 food.`)
  },

  async onUnload(bot, api) {
    clearInterval(this.timer)
    api.log('Auto Eat stopped.')
  },
}
