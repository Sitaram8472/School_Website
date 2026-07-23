import { io } from "socket.io-client";

// Get backend URL from environment variables or use default
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

let socket = null;

export const connectSocket = (token) => {
  if (socket) return socket;

  socket = io(BACKEND_URL, {
    auth: {
      token,
    },
    withCredentials: true,
  });

  socket.on("connect", () => {
    console.log("Socket connected successfully");
  });

  socket.on("connect_error", (err) => {
    console.error("Socket connection error:", err.message);
  });

  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const getSocket = () => socket;
