// OS-level stats for the admin server-monitoring panel. Deliberately no new
// npm dependency: CPU/RAM come from Node's built-in os module, disk usage
// shells out to a platform-native command (PowerShell on Windows, df on
// POSIX) since Node has no built-in cross-platform disk-space API.
const os = require('os')
const { exec } = require('child_process')

function cpuSnapshot() {
  return os.cpus().map((c) => ({
    idle: c.times.idle,
    total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
  }))
}

// Node has no instantaneous "CPU usage right now" number - os.cpus() gives
// cumulative time-since-boot counters, so a real percentage needs two
// samples a short interval apart.
function getCpuUsagePercent(sampleMs = 200) {
  return new Promise((resolve) => {
    const start = cpuSnapshot()
    setTimeout(() => {
      const end = cpuSnapshot()
      let idleDelta = 0
      let totalDelta = 0
      for (let i = 0; i < start.length; i++) {
        idleDelta += end[i].idle - start[i].idle
        totalDelta += end[i].total - start[i].total
      }
      resolve(totalDelta > 0 ? Math.max(0, Math.min(100, 100 - (idleDelta / totalDelta) * 100)) : 0)
    }, sampleMs)
  })
}

function getMemoryUsage() {
  const totalMB = os.totalmem() / (1024 * 1024)
  const freeMB = os.freemem() / (1024 * 1024)
  const usedMB = totalMB - freeMB
  return { totalMB, freeMB, usedMB, percent: totalMB > 0 ? (usedMB / totalMB) * 100 : 0 }
}

function getDiskUsage() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Filtering happens in JS (DriveType 3 = fixed disk) rather than in
      // the PowerShell -Filter clause, purely to avoid nesting quote
      // characters inside the already-quoted -Command argument.
      exec(
        'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace,DriveType | ConvertTo-Json"',
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve([])
          try {
            let parsed = JSON.parse(stdout)
            if (!Array.isArray(parsed)) parsed = [parsed]
            resolve(parsed
              .filter((d) => d.DriveType === 3 && d.Size)
              .map((d) => {
                const totalGB = d.Size / (1024 ** 3)
                const freeGB = d.FreeSpace / (1024 ** 3)
                return { drive: d.DeviceID, totalGB, freeGB, usedGB: totalGB - freeGB, percent: ((totalGB - freeGB) / totalGB) * 100 }
              }))
          } catch {
            resolve([])
          }
        }
      )
    } else {
      exec('df -k /', { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([])
        const lines = stdout.trim().split('\n')
        if (lines.length < 2) return resolve([])
        const parts = lines[1].split(/\s+/)
        const totalGB = parseInt(parts[1], 10) / (1024 * 1024)
        const usedGB = parseInt(parts[2], 10) / (1024 * 1024)
        const freeGB = parseInt(parts[3], 10) / (1024 * 1024)
        resolve([{ drive: '/', totalGB, freeGB, usedGB, percent: totalGB > 0 ? (usedGB / totalGB) * 100 : 0 }])
      })
    }
  })
}

module.exports = { getCpuUsagePercent, getMemoryUsage, getDiskUsage }
