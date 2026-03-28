const express = require("express");
const router = express.Router();

const { requireAuth } = require("../middleware/requireAuth");
const { listMyReviews, getMe, deleteAccount, listMyFavorites, addFavorite, removeFavorite } = require("../controllers/meController");

router.get("/", requireAuth, getMe);
router.get("/reviews", requireAuth, listMyReviews);
router.delete("/", requireAuth, deleteAccount);

router.get("/favorites", requireAuth, listMyFavorites);
router.put("/favorites/:slug", requireAuth, addFavorite);
router.delete("/favorites/:slug", requireAuth, removeFavorite);

module.exports = router;
