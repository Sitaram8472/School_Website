import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
let chatSession = null;

export const getAIResponse = async (userPrompt) => {
  if (!API_KEY) {
    console.warn("Gemini API key is missing in environment variables");
    return "I'm currently offline. Please contact the administration office for assistance.";
  }

  if (!userPrompt || !userPrompt.trim()) {
    return "Please enter a valid question.";
  }

  try {
    if (!chatSession) {
      const genAI = new GoogleGenerativeAI(API_KEY);
      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        systemInstruction: `You are the EduStream Academy AI Assistant. 
You provide helpful, concise information about the school, admissions, academics, and teachers. 
Key Information:
- Admissions for 2026 are open.
- We offer an Academic Resource Hub and a Real-Time Notice Board.
- We have a Summer Vacation starting June 1st, 2026.
Be professional and encouraging. Keep your answers conversational. If you don't know an answer, suggest contacting office@edustream.edu.`,
      });
      chatSession = model.startChat({
        history: [],
      });
    }

    const result = await chatSession.sendMessage(userPrompt);
    return result.response.text();
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "I'm having trouble connecting right now. Please try again later.";
  }
};

export const resetChatSession = () => {
  chatSession = null;
};