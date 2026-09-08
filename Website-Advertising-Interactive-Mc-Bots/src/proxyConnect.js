const net = require('net')
const { SocksClient } = require('socks')

// Builds the `connect` option mineflayer/minecraft-protocol expects: a
// function that receives the protocol client and is responsible for calling
// client.setSocket(socket) + client.emit('connect') once a raw socket to the
// Minecraft server has been established (docs: node-minecraft-protocol API.md).
function buildConnectOption(proxy, targetHost, targetPort) {
  return (client) => {
    connectThroughProxy(proxy, targetHost, targetPort)
      .then((socket) => {
        client.setSocket(socket)
        client.emit('connect')
      })
      .catch((err) => {
        client.emit('error', err)
      })
  }
}

async function connectThroughProxy(proxy, targetHost, targetPort) {
  if (proxy.type === 'socks5' || proxy.type === 'socks4') {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type === 'socks5' ? 5 : 4,
        userId: proxy.username || undefined,
        password: proxy.type === 'socks5' ? (proxy.password || undefined) : undefined,
      },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000,
    })
    return socket
  }

  if (proxy.type === 'http') {
    return connectViaHttpTunnel(proxy, targetHost, targetPort)
  }

  throw new Error(`Unsupported proxy type: ${proxy.type}`)
}

// Hand-rolled HTTP CONNECT tunnel (the same mechanism browsers use to proxy
// HTTPS): ask the proxy to open a raw TCP pipe to the Minecraft server, then
// hand that socket straight to the protocol client.
function connectViaHttpTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    const authHeader = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
      : ''

    socket.setTimeout(15000)
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('HTTP proxy connection timed out'))
    })
    socket.once('error', reject)

    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        `\r\n`
      )
    })

    let buffer = ''
    function onData(chunk) {
      buffer += chunk.toString('latin1')
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      socket.removeListener('data', onData)

      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
      const statusMatch = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0
      if (statusCode !== 200) {
        socket.destroy()
        reject(new Error(`HTTP proxy CONNECT failed: ${statusLine || 'no response'}`))
        return
      }

      const leftover = buffer.slice(headerEnd + 4)
      if (leftover.length > 0) {
        socket.unshift(Buffer.from(leftover, 'latin1'))
      }
      socket.setTimeout(0)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

module.exports = { buildConnectOption }
