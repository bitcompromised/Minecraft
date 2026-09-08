// Small, dependency-free line-level diff (classic LCS backtrack) used to
// show admins what changed in a module update before they approve it (see
// routes/marketplace.js's /updates/:updateId/diff). Deliberately not a full
// diff library - just enough to highlight added/removed lines line-by-line.
const MAX_DIFF_LINES = 4000

function diffLines(oldText, newText) {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // The classic O(n*m) LCS table is fine for normal module-sized files, but
  // would allocate an enormous 2D array for something pathological - bail
  // out to a summary rather than risk an OOM on a huge/binary-ish upload.
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return {
      tooLarge: true,
      oldLineCount: oldLines.length,
      newLineCount: newLines.length,
      hunks: [],
    }
  }

  const n = oldLines.length
  const m = newLines.length
  // dp[i][j] = length of the LCS of oldLines[i:] and newLines[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const hunks = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      hunks.push({ type: 'context', line: oldLines[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      hunks.push({ type: 'remove', line: oldLines[i] })
      i += 1
    } else {
      hunks.push({ type: 'add', line: newLines[j] })
      j += 1
    }
  }
  while (i < n) {
    hunks.push({ type: 'remove', line: oldLines[i] })
    i += 1
  }
  while (j < m) {
    hunks.push({ type: 'add', line: newLines[j] })
    j += 1
  }

  const additions = hunks.filter((h) => h.type === 'add').length
  const removals = hunks.filter((h) => h.type === 'remove').length

  return { tooLarge: false, additions, removals, hunks }
}

module.exports = { diffLines }
