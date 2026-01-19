import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";

export const getAIResponse = async (userPrompt) => {
  if (!API_KEY) {
    return "I'm currently offline. Please contact the administration office for assistance.";
  }

  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction:
        "You are the EduStream Academy AI Assistant. Provide helpful, concise information about the school, admissions, academics, and teachers. Be professional and encouraging. If you don't know an answer, suggest contacting office@edustream.edu.",
    });

    const result = await model.generateContent(userPrompt);
    const response = await result.response;

    return response.text() || "I'm sorry, I couldn't process that request.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "I'm having trouble connecting right now. Please try again later.";
  }
};
