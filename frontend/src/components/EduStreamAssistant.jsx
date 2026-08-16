// frontend/EduStreamAssistant.jsx
// Drop this file into src/components/EduStreamAssistant.jsx
// It is already placed correctly in your App.jsx inside <Router>

import React, { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";

const API_URL =
  import.meta.env.VITE_CHAT_API_URL || "http://localhost:5000/api/chat";

const WELCOME_MESSAGE = {
  role: "assistant",
  text: "👋 Hi! I'm the EduStream AI Assistant. Ask me about admissions, academics, scholarships, or how to navigate the site.",
  navigateTo: null,
  navigateLabel: null,
};

const SUGGESTED = [
  "What are the admission requirements?",
  "When do applications open?",
  "What scholarships are available?",
  "How do I contact the school?",
];

export default function EduStreamAssistant() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current && inputRef.current.focus(), 150);
    }
  }, [isOpen]);

  const openChat = () => {
    setIsOpen(true);
    setHasOpened(true);
  };

  const sendMessage = async (overrideText) => {
    const text = (overrideText || input).trim();
    if (!text || loading) return;

    const userMsg = { role: "user", text, navigateTo: null, navigateLabel: null };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const history = next
        .filter((m) => m.text !== WELCOME_MESSAGE.text)
        .slice(-10)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply || "Sorry, I could not process that. Please try again.",
          navigateTo: data.navigateTo || null,
          navigateLabel: data.navigateLabel || null,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "I am having trouble connecting right now. Please try again or visit the Contact page.",
          navigateTo: "/contact",
          navigateLabel: "Go to Contact",
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleNav = (path) => {
    navigate(path);
    setIsOpen(false);
  };

  const clearChat = () => setMessages([WELCOME_MESSAGE]);

  return (
    <>
      {/* Keyframe animation injected globally */}
      <style>{`
        @keyframes es-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
        .es-dot {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background-color: #9ca3af;
          animation: es-bounce 1.2s infinite ease-in-out;
          margin: 0 2px;
        }
        .es-dot:nth-child(2) { animation-delay: 0.2s; }
        .es-dot:nth-child(3) { animation-delay: 0.4s; }
        .es-fab:hover { background-color: #1e3a8a !important; transform: scale(1.05); }
        .es-send:hover:not(:disabled) { background-color: #1e3a8a !important; }
        .es-nav-btn:hover { background-color: #1d4ed8 !important; color: #fff !important; }
        .es-suggested:hover { background-color: #eff6ff !important; }
        .es-icon-btn:hover { opacity: 1 !important; background: rgba(255,255,255,0.15) !important; border-radius: 6px; }
      `}</style>

      <div style={S.wrapper}>
        {/* ── Chat Window ── */}
        {isOpen && (
          <div style={S.window}>

            {/* Header */}
            <div style={S.header}>
              <div style={S.headerLeft}>
                <div style={S.avatar}>🎓</div>
                <div>
                  <div style={S.headerTitle}>EduStream Assistant</div>
                  <div style={S.headerSub}>Ask me anything about EduStream</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="es-icon-btn" style={S.iconBtn} onClick={clearChat} title="Clear chat">↺</button>
                <button className="es-icon-btn" style={S.iconBtn} onClick={() => setIsOpen(false)} title="Close">✕</button>
              </div>
            </div>

            {/* Messages */}
            <div style={S.messages} ref={scrollRef}>

              {/* Suggested questions — only on fresh chat */}
              {messages.length === 1 && (
                <div style={{ marginBottom: 8 }}>
                  <p style={S.suggestedLabel}>Try asking:</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {SUGGESTED.map((q) => (
                      <button
                        key={q}
                        className="es-suggested"
                        style={S.suggestedBtn}
                        onClick={() => sendMessage(q)}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Message bubbles */}
              {messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                    alignItems: "flex-end",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  {m.role === "assistant" && (
                    <div style={S.bubbleAvatar}>AI</div>
                  )}
                  <div style={m.role === "user" ? S.userBubble : S.aiBubble}>
                    {m.text}
                    {m.navigateTo && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          className="es-nav-btn"
                          style={S.navBtn}
                          onClick={() => handleNav(m.navigateTo)}
                        >
                          {m.navigateLabel || `Go to ${m.navigateTo}`} →
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Typing indicator */}
              {loading && (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 6, marginBottom: 8 }}>
                  <div style={S.bubbleAvatar}>AI</div>
                  <div style={{ ...S.aiBubble, padding: "10px 14px" }}>
                    <span className="es-dot" />
                    <span className="es-dot" />
                    <span className="es-dot" />
                  </div>
                </div>
              )}
            </div>

            {/* Input */}
            <div style={S.inputRow}>
              <input
                ref={inputRef}
                style={S.input}
                type="text"
                placeholder="Ask about admissions, fees, courses..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKey}
                disabled={loading}
                maxLength={500}
              />
              <button
                className="es-send"
                style={{
                  ...S.sendBtn,
                  opacity: !input.trim() || loading ? 0.45 : 1,
                  cursor: !input.trim() || loading ? "not-allowed" : "pointer",
                }}
                onClick={() => sendMessage()}
                disabled={!input.trim() || loading}
              >
                ➤
              </button>
            </div>

            {/* Footer */}
            <div style={S.footer}>Powered by EduStream AI</div>
          </div>
        )}

        {/* ── Floating Button ── */}
        <button
          className="es-fab"
          style={S.fab}
          onClick={isOpen ? () => setIsOpen(false) : openChat}
          aria-label="EduStream AI Assistant"
        >
          <span style={{ fontSize: isOpen ? 20 : 26 }}>{isOpen ? "✕" : "💬"}</span>
          {!hasOpened && <span style={S.badge}>1</span>}
        </button>
      </div>
    </>
  );
}

const BLUE = "#1d4ed8";

const S = {
  wrapper: {
    position: "fixed",
    bottom: 24,
    right: 24,
    zIndex: 99999,
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
  },
  window: {
    width: 355,
    height: 490,
    backgroundColor: "#fff",
    borderRadius: 16,
    boxShadow: "0 12px 40px rgba(0,0,0,0.18)",
    display: "flex",
    flexDirection: "column",
    marginBottom: 12,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
  },
  header: {
    backgroundColor: BLUE,
    color: "#fff",
    padding: "12px 14px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexShrink: 0,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    backgroundColor: "rgba(255,255,255,0.2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
  },
  headerTitle: { fontWeight: 700, fontSize: 14, lineHeight: 1.2 },
  headerSub: { fontSize: 11, opacity: 0.8, marginTop: 1 },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#fff",
    fontSize: 15,
    cursor: "pointer",
    padding: "4px 7px",
    opacity: 0.85,
    lineHeight: 1,
  },
  messages: {
    flex: 1,
    padding: "12px 12px 4px",
    overflowY: "auto",
    backgroundColor: "#f8fafc",
  },
  suggestedLabel: {
    fontSize: 11.5,
    color: "#6b7280",
    margin: "0 0 6px 0",
    fontWeight: 500,
  },
  suggestedBtn: {
    background: "#fff",
    border: `1.5px solid ${BLUE}`,
    color: BLUE,
    borderRadius: 20,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
    textAlign: "left",
    fontWeight: 500,
    width: "100%",
  },
  bubbleAvatar: {
    width: 26,
    height: 26,
    borderRadius: "50%",
    backgroundColor: BLUE,
    color: "#fff",
    fontSize: 9,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  aiBubble: {
    maxWidth: "78%",
    padding: "9px 13px",
    borderRadius: 14,
    borderBottomLeftRadius: 3,
    fontSize: 13.5,
    lineHeight: 1.5,
    backgroundColor: "#fff",
    color: "#1f2937",
    border: "1px solid #e5e7eb",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    wordBreak: "break-word",
  },
  userBubble: {
    maxWidth: "78%",
    padding: "9px 13px",
    borderRadius: 14,
    borderBottomRightRadius: 3,
    fontSize: 13.5,
    lineHeight: 1.5,
    backgroundColor: BLUE,
    color: "#fff",
    wordBreak: "break-word",
    marginLeft: "auto",
  },
  navBtn: {
    border: `1.5px solid ${BLUE}`,
    backgroundColor: "transparent",
    color: BLUE,
    padding: "5px 10px",
    borderRadius: 8,
    fontSize: 12,
    cursor: "pointer",
    fontWeight: 600,
    transition: "all 0.2s",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    borderTop: "1px solid #e5e7eb",
    padding: "8px 10px",
    gap: 8,
    backgroundColor: "#fff",
    flexShrink: 0,
  },
  input: {
    flex: 1,
    border: "1.5px solid #d1d5db",
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 13.5,
    outline: "none",
    backgroundColor: "#f9fafb",
    color: "#111827",
  },
  sendBtn: {
    border: "none",
    backgroundColor: BLUE,
    color: "#fff",
    borderRadius: 10,
    width: 36,
    height: 36,
    fontSize: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background-color 0.2s",
  },
  footer: {
    textAlign: "center",
    fontSize: 10.5,
    color: "#9ca3af",
    padding: "4px 0 6px",
    backgroundColor: "#fff",
    flexShrink: 0,
  },
  fab: {
    width: 58,
    height: 58,
    borderRadius: "50%",
    border: "none",
    backgroundColor: BLUE,
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 4px 16px rgba(29,78,216,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    transition: "background-color 0.2s, transform 0.15s",
  },
  badge: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: "50%",
    backgroundColor: "#ef4444",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "2px solid #fff",
  },
};
