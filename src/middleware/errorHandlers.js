// src/middleware/errorHandlers.js
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

/**
 * Central error handler.
 * Supports:
 *  - err.status (number): HTTP status override
 *  - err.code (string): stable error code for clients
 *  - err.details (object): optional extra info (validation errors, etc.)
 */
function errorHandler(err, req, res, next) {
  const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 500;

  const code =
    typeof err?.code === "string" && err.code.trim()
      ? err.code
      : status === 500
      ? "INTERNAL"
      : "ERROR";

  const message =
    typeof err?.message === "string" && err.message.trim()
      ? err.message
      : status === 500
      ? "Internal server error"
      : "Request failed";

  // Log full error server-side, but don't leak internals to client
  console.error("ERROR:", {
    status,
    code,
    message,
    details: err?.details,
    stack: err?.stack,
  });

  const payload = { error: { code, message } };
  if (err?.details && typeof err.details === "object") {
    payload.error.details = err.details;
  }

  res.status(status).json(payload);
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
