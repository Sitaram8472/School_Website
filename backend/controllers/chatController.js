const { getAIResponse } = require("../config/aiProvider");
const knowledgeBase = require("../data/knowledgeBase");
const siteRoutes = require("../data/siteRoutes");
const AnalyticsEvent = require("../models/AnalyticsEvent");

// Build a formatted list of pages for the system prompt
const routesList = siteRoutes
  .map((r) => `  - ${r.path} (${r.label}): ${r.description}`)
  .join("\n");

// Valid paths for response validation
const validPaths = siteRoutes.map((r) => r.path);

// ─────────────────────────────────────────
// SYSTEM PROMPT
// Instructs the AI on its role, what it knows, and how to respond
// ─────────────────────────────────────────
const SYSTEM_PROMPT = `
You are the official AI Assistant for EduStream Academy, embedded as a floating
chat widget on the EduStream website.

Your two responsibilities:
1. ANSWER QUESTIONS — using ONLY the knowledge base provided below.
2. GUIDE NAVIGATION — direct users to the correct page on the site.

════════════════════════════════════════
AVAILABLE SITE PAGES (for navigation):
════════════════════════════════════════
${routesList}

════════════════════════════════════════
KNOWLEDGE BASE (your only source of truth):
════════════════════════════════════════
${knowledgeBase}

════════════════════════════════════════
STRICT RULES:
════════════════════════════════════════
1. Only use facts from the KNOWLEDGE BASE above. Never invent fees, dates, names,
   or policies not explicitly stated in the knowledge base.
2. If the user asks something not covered in the knowledge base (e.g. specific fee
   amounts, real-time application status, personalised advice), politely say you
   don't have that detail and suggest they fill the Enquiry Form on /contact or
   call +91 33 2582 0000 directly.
3. If the user wants to navigate somewhere (e.g. "show me the gallery", "where do
   I apply", "how do I contact you"), set navigateTo to the single most relevant
   path from AVAILABLE SITE PAGES.
4. Keep replies concise and friendly — 1 to 4 sentences for simple questions,
   more detail only when the user explicitly asks for it.
5. Always respond in STRICT JSON only — no markdown, no code fences, no extra text.
   Use exactly this structure:
   {
     "reply": "Your friendly answer here",
     "navigateTo": "/path or null",
     "navigateLabel": "Button label e.g. Go to Contact, or null"
   }
`;

// ─────────────────────────────────────────
// CONTROLLER
// ─────────────────────────────────────────
const handleChat = async (req, res) => {
  try {
    const { message, history } = req.body;

    // 1. Validate request
    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({
        error: "message is required and must be a non-empty string.",
      });
    }

    // 2. Sanitise conversation history (keep last 10 turns, valid roles only)
    const cleanHistory = Array.isArray(history)
      ? history
          .filter(
            (h) =>
              h &&
              typeof h.text === "string" &&
              ["user", "assistant"].includes(h.role)
          )
          .slice(-10)
      : [];

    // 3. Call AI provider
    const rawText = await getAIResponse(SYSTEM_PROMPT, cleanHistory, message.trim());

    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*|^```\s*|```\s*$/gm, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.warn("AI response was not valid JSON, wrapping as plain reply.");
      parsed = { reply: rawText, navigateTo: null, navigateLabel: null };
    }

    // 5. Validate navigateTo — reject any path not in siteRoutes
    if (parsed.navigateTo && !validPaths.includes(parsed.navigateTo)) {
      console.warn(`Invalid navigateTo "${parsed.navigateTo}" — stripping.`);
      parsed.navigateTo = null;
      parsed.navigateLabel = null;
    }

    // 6. Send structured response
    // Log Analytics Event (AI Query)
    if (req.user && req.user._id) {
      await AnalyticsEvent.create({ eventType: 'AI_QUERY', userId: req.user._id }).catch(err => console.error("Analytics error:", err));
    }

    return res.status(200).json({
      reply: parsed.reply || "I'm sorry, I didn't understand that. Could you rephrase?",
      navigateTo: parsed.navigateTo || null,
      navigateLabel: parsed.navigateLabel || null,
    });

  } catch (err) {
    console.error("chatController error:", err.message || err);
    return res.status(500).json({
      reply:
        "I'm having trouble right now. Please try again shortly, or reach us at admissions@edustream.edu.",
      navigateTo: "/contact",
      navigateLabel: "Go to Contact",
    });
  }
};

module.exports = { handleChat };

