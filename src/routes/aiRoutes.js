const express = require("express");
const router = express.Router();
const { getAiStatus, runAiQuery, getAiSession } = require("../controllers/aiController");
const { requireAuth } = require("../middleware/requireAuth");
const { userAiQuotaMiddleware } = require("../middleware/rateLimiter");

router.get("/status", getAiStatus);
router.post("/query", requireAuth, userAiQuotaMiddleware, runAiQuery);
router.get("/session/:sessionId", requireAuth, getAiSession);

module.exports = router;
