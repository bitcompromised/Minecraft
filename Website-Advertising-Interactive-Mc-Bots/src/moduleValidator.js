// Checks an uploaded module file before it is ever accepted, so a file that
// could never load doesn't sit in the review queue waiting to waste an
// admin's time (and doesn't blow up on a bot months later).
//
// Two things are verified:
//
//   1. It parses. The source is compiled exactly the way Node compiles a
//      CommonJS module - wrapped in the same function header - so top-level
//      `return`, `await` outside async, and so on behave as they really
//      would. Compiling is NOT running: `new vm.Script(...)` parses and
//      produces bytecode, and nothing in the file executes. That matters,
//      because at this point the code has had no human review at all.
//
//   2. It exports the contract. A module has to hand back an object with an
//      onLoad function (see views/marketplace-api.ejs). This is checked
//      statically, by looking for the assignment - the alternative would be
//      executing the top level of an unreviewed file, which is exactly what
//      the sandbox exists to avoid.
//
// A static export check can't be perfect: a module that builds its exports
// through enough indirection will slip past. That's fine - the goal is to
// catch the honest mistakes (wrong filename, ES module syntax, forgot to
// export) rather than to be a security boundary. The sandbox is the boundary.

const vm = require('vm')

// The same wrapper Node uses for CommonJS modules.
const WRAPPER_HEAD = '(function (exports, require, module, __filename, __dirname) {'
const WRAPPER_TAIL = '\n});'

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

function checkSyntax(source) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(`${WRAPPER_HEAD}${source}${WRAPPER_TAIL}`, { filename: 'module.js' })
    return null
  } catch (err) {
    // V8 puts the offending line in the stack rather than the message, and
    // the wrapper shifts every line number by zero (the wrapper head has no
    // trailing newline), so the reported line is the real one.
    const detail = String(err.message || 'Syntax error')
    const match = /module\.js:(\d+)/.exec(err.stack || '')
    return match ? `Line ${match[1]}: ${detail}` : detail
  }
}

// Strips comments and string literals so the export search doesn't match a
// mention of "module.exports" inside a comment or a docstring. Crude on
// purpose - it only needs to be good enough to avoid false positives.
function stripNonCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""')
}

// ES module syntax is the most common way an upload goes wrong, and it is
// *also* a syntax error inside the CommonJS wrapper - so it has to be
// detected before checkSyntax, or the author just gets "Unexpected token
// 'export'" and has to work out what that means.
function checkEsModuleSyntax(source) {
  const code = stripNonCode(source)
  if (/^\s*export\s+(default|const|let|var|function|class|async|\{|\*)/m.test(code)) {
    return 'This file uses ES module syntax (`export ...`). Modules are loaded with require(), so use `module.exports = { name, async onLoad(bot, api) { ... } }` instead.'
  }
  if (/^\s*import\s+[\w{*]/m.test(code)) {
    return 'This file uses ES module syntax (`import ...`). Use `const x = require(\'x\')` instead - and note that bare package names must be on the admin import allowlist.'
  }
  return null
}

function checkExports(source) {
  const code = stripNonCode(source)

  const assignsModuleExports = /\bmodule\s*\.\s*exports\s*=/.test(code)
  const assignsExportsProperty = /\bexports\s*\.\s*\w+\s*=/.test(code)
  const assignsOnLoadProperty = /\b(module\s*\.\s*)?exports\s*\.\s*onLoad\s*=/.test(code)

  if (!assignsModuleExports && !assignsExportsProperty) {
    return 'Nothing is exported. A module must end with `module.exports = { name, async onLoad(bot, api) { ... } }`.'
  }

  // Whichever export style was used, onLoad has to be reachable through it.
  const mentionsOnLoad = /\bonLoad\b/.test(code)
  if (!mentionsOnLoad) {
    return 'The exported object has no `onLoad` function. That is the entry point called when someone loads the module onto a bot.'
  }

  if (assignsExportsProperty && !assignsModuleExports && !assignsOnLoadProperty) {
    return '`onLoad` is not exported. Add `exports.onLoad = async (bot, api) => { ... }`, or export the whole object with `module.exports = { ... }`.'
  }

  return null
}

// Returns an array of human-readable problems; empty means the file is
// acceptable. Never throws.
function validateModuleSource(source) {
  const problems = []

  if (typeof source !== 'string' || source.trim().length === 0) {
    return ['The file is empty.']
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return ['The file is larger than 2MB.']
  }
  // A .js file that starts with a shebang is fine for a CLI script but is
  // not something the sandbox's require() will accept.
  if (source.startsWith('#!')) {
    problems.push('Remove the `#!` shebang line - this is a module, not a script.')
  }

  const esmProblem = checkEsModuleSyntax(source)
  if (esmProblem) {
    problems.push(esmProblem)
    return problems
  }

  const syntaxProblem = checkSyntax(source)
  if (syntaxProblem) {
    // No point reporting export problems for a file that doesn't parse; the
    // parser gave up somewhere and everything after that is guesswork.
    problems.push(`The file has a syntax error and would never load. ${syntaxProblem}`)
    return problems
  }

  const exportProblem = checkExports(source)
  if (exportProblem) problems.push(exportProblem)

  return problems
}

module.exports = { validateModuleSource, checkSyntax, checkExports, checkEsModuleSyntax, MAX_SOURCE_BYTES }
