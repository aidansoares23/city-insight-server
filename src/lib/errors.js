/**
 * Application-level error with an HTTP `status` code and a machine-readable `code` string.
 * Defaults to `500` / `"ERROR"` when not specified.
 */
class AppError extends Error {
  constructor(message, { status = 500, code = "ERROR" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { AppError };
