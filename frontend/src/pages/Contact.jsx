import { useState } from "react";
import { getAIResponse } from "../services/geminiService";

const Contact = () => {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");

  const askAI = async () => {
    const res = await getAIResponse(question);
    setReply(res);
  };

  return (
    <div>
      <h1>Contact Us</h1>

      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about admissions..."
      />

      <button onClick={askAI}>Ask AI</button>

      <p>{reply}</p>
    </div>
  );
};

export default Contact;
