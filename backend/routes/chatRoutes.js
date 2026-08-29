// routes/chatRoutes.js
// Defines all routes for the chat API.
// Route logic lives in controllers/chatController.js — not here.

const express = require("express");
const router = express.Router();
const { handleChat } = require("../controllers/chatController");
const { protect } = require("../middleware/Auth");

// GET /api/health
// Simple uptime/sanity check — returns 200 if the server is alive.
router.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// The knowledge the assistant answers from, as records rather than a template
// literal in data/knowledgeBase.js. Mounted here because it belongs to the
// assistant, and required inline so this sub-resource costs the file one line.
// Its read routes are public and attach their own optionalProtect.
router.use("/knowledge-articles", require("./knowledgeRoutes"));

// POST /api/chat
// Body: { message: string, history: Array<{ role: "user"|"assistant", text: string }> }
// Returns: { reply: string, navigateTo: string|null, navigateLabel: string|null }
router.post("/chat", protect, handleChat);

module.exports = router;