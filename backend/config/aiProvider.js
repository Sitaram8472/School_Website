require("dotenv").config();
const Groq = require("groq-sdk");

if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY is missing from environment variables.");
  process.exit(1);
}

const groq = new Groq({ 
  apiKey: process.env.GROQ_API_KEY,
  timeout: 30000,
});

async function getAIResponse(systemPrompt, history, userMessage) {
  try {
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      throw new Error('System prompt is required');
    }

    if (!userMessage || typeof userMessage !== 'string') {
      throw new Error('User message is required');
    }

    if (!Array.isArray(history)) {
      throw new Error('History must be an array');
    }

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.map((h) => ({
        role: h.role === "user" ? "user" : "assistant",
        content: h.text,
      })),
      { role: "user", content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.4,
      max_tokens: 512,
      response_format: { type: "json_object" },
    });

    const content = completion.choices[0]?.message?.content?.trim() || "";
    
    if (!content) {
      throw new Error('Empty response from AI');
    }

    try {
      JSON.parse(content);
    } catch {
      throw new Error('Invalid JSON response from AI');
    }

    return content;

  } catch (error) {
    console.error('AI Provider Error:', error.message);
    throw new Error(`AI service failed: ${error.message}`);
  }
}

module.exports = { getAIResponse };