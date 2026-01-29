// src/routes/meRoutes.js
const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/requireAuth");
const { listMyReviews, getMe } = require("../controllers/meController");

router.get("/", requireAuth, getMe);
router.get("/reviews", requireAuth, listMyReviews);

module.exports = router;
