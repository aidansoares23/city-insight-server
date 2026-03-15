const express = require("express");
const { login, logout } = require("../controllers/authController");

const router = express.Router();

/** Route-level CSRF-lite guard: rejects requests without `X-Requested-With: XMLHttpRequest`. */
function requireCsrfLite(req, res, next) {
  if (req.get("x-requested-with") !== "XMLHttpRequest") {
    return res.status(403).json({
      error: { code: "CSRF", message: "Missing CSRF header" },
    });
  }
  next();
}

router.post("/login", requireCsrfLite, login);
router.post("/logout", requireCsrfLite, logout);

module.exports = router;
