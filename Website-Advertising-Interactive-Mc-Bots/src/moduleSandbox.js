// Owns one worker_thread (src/sandboxWorker.js) per loaded module, from the
// side that holds the real, live mineflayer `bot` object (this always runs
// inside botChild.js, i.e. that bot's own child process - see
// botManager.js for the process-per-bot-connection layer this sits inside
// of). Resolves the sandbox's "botCall" property-read/method-call requests
// against the real bot and forwards subscribed bot events into it.
const path = require('path')
const { Worker } = require('worker_threads')
const { Vec3 } = require('vec3')

const WORKER_PATH = path.join(__dirname, 'sandboxWorker.js')
const UNLOAD_TIMEOUT_MS = 5000

// How deep into an argument to go looking for positions. Deep enough for an
// option bag like findBlocks({ point: ..., maxDistance: 80 }), shallow
// enough that a large structure isn't walked in full on every call.
const MAX_REVIVE_DEPTH = 3

// Arguments are structured-cloned on their way out of the worker, which
// strips prototypes - a position sent as a Vec3 arrives here as a bare
// {x, y, z}. Most of mineflayer's positional API then throws, because it
// calls Vec3 methods on whatever it was handed (bot.blockAt does
// pos.floored(), bot.lookAt does point.minus(...)). Rebuilding them on this
// side is what makes those methods reachable from a module at all: there is
// no way for the sandbox to send a live Vec3 instead, since the clone would
// flatten it again on the way out.
//
// Only an object whose keys are exactly x, y and z, all numbers, is treated
// as a position - everything else is passed through untouched.
function reviveVectors(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_REVIVE_DEPTH) return value
  if (Array.isArray(value)) return value.map((entry) => reviveVectors(entry, depth + 1))

  const keys = Object.keys(value)
  const isPosition = keys.length === 3
    && keys.every((key) => (key === 'x' || key === 'y' || key === 'z') && typeof value[key] === 'number')
  if (isPosition) return new Vec3(value.x, value.y, value.z)

  const revived = {}
  for (const key of keys) revived[key] = reviveVectors(value[key], depth + 1)
  return revived
}

// Worker postMessage uses the structured clone algorithm, which can throw
// on some exotic values (native handles, etc.) and never preserves custom
// class prototypes anyway (Vec3/Block/Entity arrive as plain data on the
// sandbox side) - round-tripping through JSON gets the same practical
// result more predictably, and never throws.
function safeSerialize(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

class ModuleSandbox {
  constructor({ bot, moduleRecord, allowlist, onLog }) {
    this.bot = bot
    this.moduleRecord = moduleRecord
    this.onLog = onLog
    this.subscribedEvents = new Set()
    this.worker = new Worker(WORKER_PATH, {
      workerData: { filePath: moduleRecord.filePath, allowlist },
    })
    this.terminated = false
    this.worker.on('message', (msg) => this._handleMessage(msg))
    this.worker.on('error', (err) => {
      // An uncaught throw that escapes the worker's own handlers. The stack
      // is the useful part for a module author, so keep it.
      this.onLog?.('error', `Sandbox crashed: ${err.stack || err.message}`)
    })
    // Fires whether the worker exited cleanly, threw its way out, or was
    // killed. Without this the sandbox could disappear with no trace and the
    // module would still be listed as loaded (see botChild.js's onExit).
    this.worker.on('exit', (code) => {
      if (this.terminated) return
      this.onExit?.(code)
    })
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'log':
        this.onLog?.(msg.level, msg.message)
        break
      case 'apiLog':
        this.onApiLog?.(msg.message)
        break
      // The module's own description of the chat commands it answers to,
      // already sanitised worker-side (see sandboxWorker.js).
      case 'commands':
        this.commands = Array.isArray(msg.commands) ? msg.commands : []
        this.onCommands?.(this.commands)
        break
      case 'subscribeEvent':
        this.subscribedEvents.add(msg.event)
        break
      case 'botCall':
        this._handleBotCall(msg)
        break
      case 'loadResult':
        this._pendingLoad?.(msg)
        break
      case 'unloadResult':
        this._pendingUnload?.(msg)
        break
      default:
        break
    }
  }

  async _handleBotCall({ callId, path: pathArr, args }) {
    try {
      let result
      if (args === undefined) {
        // Plain property read - walk the whole path.
        let value = this.bot
        for (const key of pathArr) value = value?.[key]
        result = value
      } else {
        // Method call - walk to the owning object, then invoke the last
        // segment as a method on it (so `this` inside the real method is
        // still the real bot/sub-object, not lost through indirection).
        let owner = this.bot
        for (let i = 0; i < pathArr.length - 1; i++) owner = owner?.[pathArr[i]]
        const methodName = pathArr[pathArr.length - 1]
        if (typeof owner?.[methodName] !== 'function') {
          throw new Error(`bot.${pathArr.join('.')} is not a function.`)
        }
        result = await owner[methodName](...reviveVectors(args))
      }
      this.worker.postMessage({ type: 'botCallResult', callId, ok: true, result: safeSerialize(result) })
    } catch (err) {
      this.worker.postMessage({ type: 'botCallResult', callId, ok: false, error: err.message })
    }
  }

  // Called by botChild.js's forwardToModules() for every real mineflayer
  // event this sandbox has subscribed to via api.on(...) - cheap no-op
  // otherwise. `args` is the real listener argument array mineflayer passed
  // (e.g. ['move'] fires with none, 'chat' fires with
  // [username, message, translate, jsonMsg, matches]) - kept as an array
  // (not a single `data` value) so sandboxWorker.js can call the module's
  // handler with the same signature a real bot.on(...) listener would get.
  forwardEvent(event, args) {
    if (!this.subscribedEvents.has(event)) return
    this.worker.postMessage({ type: 'botEvent', event, args: safeSerialize(args) })
  }

  load() {
    return new Promise((resolve) => {
      this._pendingLoad = resolve
      this.worker.postMessage({ type: 'load' })
    })
  }

  unload() {
    return new Promise((resolve) => {
      let done = false
      const finish = (result) => {
        if (done) return
        done = true
        this.terminate()
        resolve(result)
      }
      this._pendingUnload = finish
      this.worker.postMessage({ type: 'unload' })
      setTimeout(() => finish({ ok: true, timedOut: true }), UNLOAD_TIMEOUT_MS).unref()
    })
  }

  terminate() {
    // Marks this as a deliberate shutdown so the 'exit' handler above
    // doesn't report an intentional unload as a crash.
    this.terminated = true
    try {
      this.worker.terminate()
    } catch {
      // already gone
    }
  }
}

module.exports = { ModuleSandbox }
