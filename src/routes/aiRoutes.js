const express = require("express");
const router = express.Router();
const { getAiStatus, runAiQuery, getAiSession } = require("../controllers/aiController");
const { requireAuth } = require("../middleware/requireAuth");

router.get("/status", getAiStatus);
router.post("/query", requireAuth, runAiQuery);
router.get("/session/:sessionId", requireAuth, getAiSession);

module.exports = router;
