// Express 4 doesn't catch rejected promises from async route handlers /
// middleware on its own - an unhandled rejection just hangs the request
// forever instead of failing visibly. Wrapping every async handler with
// this forwards any rejection to Express's next(err) or centralized
// error-handling middleware (see server.js).
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

module.exports = { asyncHandler }
