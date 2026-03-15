/** Express middleware that returns a `404 NOT_FOUND` JSON response for unmatched routes. */
function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

/**
 * Express error-handling middleware (4-arg signature).
 * Logs the error, derives HTTP status/code/message from the error object (falling back to 500/INTERNAL),
 * and returns a JSON `{ error }` payload. Attaches `details` when present.
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
