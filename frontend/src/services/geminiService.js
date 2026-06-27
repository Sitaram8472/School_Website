import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

export const getAIResponse = async (userPrompt) => {
  if (!API_KEY) {
    console.warn("Gemini API key is missing in environment variables");
    return "I'm currently offline. Please contact the administration office for assistance!";
  }

  if (!userPrompt || !userPrompt.trim()) {
    return "Please enter a valid question.";
  }

  try {
    const genAI = new GoogleGenerativeAI(API_KEY);

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: [
        "You are the EduStream Academy AI Assistant.",
        "Provide helpful, concise information about the school, admissions, academics, and teachers.",
        "Be professional and encouraging.",
        "If you don't know an answer, suggest contacting office@edustream.edu.",
        "Do not provide personal opinions or unrelated information.",
        "Keep responses clear and focused on the user's query.",
        "Avoid unnecessary repetition and ensure the information is accurate and relevant.",
      ].join(" "),
    });
    
    const result = await model.generateContent(userPrompt);

    const responseText =
      result?.response?.text?.() ||
      "I'm sorry, I couldn't process that request.";

    return responseText;
  } catch (error) {
    console.error("Gemini API Error:", error);

    // Better fallback message
    return "I'm having trouble connecting right now. Please try again later!";
  }
};
