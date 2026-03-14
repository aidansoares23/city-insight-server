const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/requireAuth");
const { listMyReviews, getMe, deleteAccount } = require("../controllers/meController");

router.get("/", requireAuth, getMe);
router.get("/reviews", requireAuth, listMyReviews);
router.delete("/", requireAuth, deleteAccount);

module.exports = router;
