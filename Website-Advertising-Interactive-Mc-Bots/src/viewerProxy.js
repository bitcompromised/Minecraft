// Serves each connection's 3D viewer through the panel's own origin.
//
// prismarine-viewer runs its own HTTP + socket.io server on its own port,
// inside that connection's child process. Pointing the browser straight at
// it (which is what the Play page used to do, as
// http://<panel host>:<viewer port>) breaks in three ordinary situations,
// none of them the user's fault:
//
//   * the panel is served over HTTPS - the browser blocks the http:// frame
//     as mixed content, and the 3D view is simply blank;
//   * the panel is behind a reverse proxy or on a remote host - only the
//     panel's port is open, and the viewer's random high port is not;
//   * the viewer port is reachable but unauthenticated - anyone who guesses
//     it watches someone else's bot.
//
// Proxying fixes all three: the frame is same-origin, same scheme, same
// port, and every request passes the same session check the rest of the
// panel does.
//
// Path layout matters here and is not arbitrary. The viewer is started with
// `prefix` set to the same /viewer/<profileId>/<serverId> path this mounts
// on, because prismarine-viewer's browser bundle derives its socket.io URL
// from `window.location.pathname` while its server derives it from the
// prefix. They agree only when the page's path *is* the prefix, so requests
// are forwarded with their URL untouched rather than rewritten.

const http = require('http')
const net = require('net')

// /viewer/<profileId>/<serverId>[/rest...] - the ids are uuids as written
// by botManager's viewerPath().
const VIEWER_PATH = /^\/viewer\/([^/]+)\/([^/]+)(\/.*)?$/

function parseViewerPath(url) {
  const match = VIEWER_PATH.exec((url || '').split('?')[0])
  if (!match) return null
  return {
    profileId: decodeURIComponent(match[1]),
    serverId: decodeURIComponent(match[2]),
  }
}

// Hop-by-hop headers belong to one connection and must not be relayed
// (RFC 9110); `host` is rewritten to the upstream we actually dial.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function forwardableHeaders(headers, upstreamHost) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    // The panel's session cookie has no business reaching the viewer, and
    // the viewer never looks at one.
    if (name.toLowerCase() === 'cookie') continue
    out[name] = value
  }
  out.host = upstreamHost
  return out
}

function createViewerProxy({ botManager, db, sessionMiddleware }) {
  // Resolves the connection this request is for, and whether the session
  // that made it is allowed to watch. Returns the viewer's port, or a
  // reason it cannot be served.
  async function authorize(url, userId) {
    const target = parseViewerPath(url)
    if (!target) return { error: 404, reason: 'Not a viewer path.' }
    if (!userId) return { error: 401, reason: 'Not signed in.' }

    // Ownership, not just a valid session: viewer URLs are guessable, and a
    // 3D view of someone else's bot is a live look at their account.
    const profile = await db.findBotProfile(target.profileId, userId)
    if (!profile) return { error: 404, reason: 'Bot profile not found.' }

    const status = botManager.getStatus(target.profileId, target.serverId)
    if (!status || !status.viewerPort) {
      return { error: 503, reason: 'The 3D viewer for this connection is not running.' }
    }
    return { port: status.viewerPort }
  }

  // ---- ordinary HTTP: the page, its bundle, textures, socket.io polling ----
  function middleware(req, res, next) {
    if (!parseViewerPath(req.originalUrl || req.url)) return next()

    authorize(req.originalUrl || req.url, req.session?.userId)
      .then(({ port, error, reason }) => {
        if (error) {
          res.status(error)
          return res.type('text/plain').send(reason)
        }

        const upstream = http.request({
          host: '127.0.0.1',
          port,
          method: req.method,
          // Untouched, prefix and all - see the note at the top.
          path: req.originalUrl || req.url,
          headers: forwardableHeaders(req.headers, `127.0.0.1:${port}`),
        }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        })

        upstream.on('error', () => {
          // The child process died between the status check and this
          // request, or the viewer is still coming up.
          if (!res.headersSent) res.status(502).type('text/plain').send('The 3D viewer is not responding.')
          else res.end()
        })

        req.pipe(upstream)
        return undefined
      })
      .catch(next)
  }

  // ---- the websocket upgrade ----
  //
  // Attached to the HTTP server rather than to express, because an upgrade
  // never reaches the express stack. socket.io's own upgrade listener is on
  // the same server and ignores paths that are not its own - it schedules a
  // "nothing was written, so nobody handled this" cleanup, which this beats
  // simply by writing the upgrade response.
  function handleUpgrade(req, socket, head) {
    if (!parseViewerPath(req.url)) return

    socket.on('error', () => socket.destroy())

    // No response object exists during an upgrade; express-session only
    // needs somewhere to put headers it will never send, which is what
    // socket.io does with it too.
    sessionMiddleware(req, {}, () => {
      authorize(req.url, req.session?.userId)
        .then(({ port, error }) => {
          if (error) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            socket.destroy()
            return
          }

          const upstream = net.connect(port, '127.0.0.1', () => {
            const headers = forwardableHeaders(req.headers, `127.0.0.1:${port}`)
            const lines = [`${req.method} ${req.url} HTTP/1.1`]
            for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
            // Put back the two hop-by-hop headers that are the whole point
            // of an upgrade request.
            lines.push('Connection: Upgrade')
            lines.push(`Upgrade: ${req.headers.upgrade}`)

            upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
            // Bytes the server already read past the headers, which would
            // otherwise be lost - typically the first websocket frame.
            if (head && head.length) upstream.write(head)

            upstream.pipe(socket)
            socket.pipe(upstream)
          })

          upstream.on('error', () => socket.destroy())
          socket.on('close', () => upstream.destroy())
        })
        .catch(() => socket.destroy())
    })
  }

  return { middleware, handleUpgrade, parseViewerPath }
}

module.exports = { createViewerProxy, parseViewerPath }
