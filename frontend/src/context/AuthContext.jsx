import React, { createContext, useState, useEffect } from "react";
import api from "../utils/axios";
import { connectSocket, disconnectSocket } from "../utils/socket";

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Load user from localStorage
  useEffect(() => {
    try {
      const userInfo = localStorage.getItem("userInfo");
      const token = localStorage.getItem("token");

      if (userInfo) {
        setUser(JSON.parse(userInfo));
        if (token) {
          connectSocket(token);
        }
      }
    } catch (error) {
      console.error("Failed to load user from localStorage:", error);

      localStorage.removeItem("userInfo");
    } finally {
      setLoading(false);
    }
  }, []);

  // Login Function
  const login = async (email, password) => {
    try {
      const { data } = await api.post("/auth/login", {
        email,
        password,
      });

      setUser(data.user);

      localStorage.setItem("userInfo", JSON.stringify(data.user));
      if (data.token) {
        localStorage.setItem("token", data.token);
        connectSocket(data.token);
      }

      return data;
    } catch (error) {
      console.error("Login Error:", error);

      if (error.response?.data?.needsVerification) {
        throw error.response.data;
      }

      throw (
        error.response?.data?.message ||
        error.message ||
        "Login failed"
      );
    }
  };

  // Register Function - account remains unauthenticated until email verification
  const register = async (name, email, password, role = "student") => {
    try {
      const { data } = await api.post("/auth/register", {
        name,
        email,
        password,
        role,
      });

      return data;
    } catch (error) {
      console.error("Registration Error:", error);

      throw (
        error.response?.data?.message ||
        error.message ||
        "Registration failed"
      );
    }
  };

  // Logout Function
  const logout = async () => {
    try {
      // Attempt to notify backend to invalidate cookies/tokens
      await api.post("/auth/logout");
    } catch (error) {
      console.error("Backend Logout Error:", error);
    } finally {
      // ALWAYS clear local state, even if the backend request fails (e.g., token expired)
      setUser(null);
      localStorage.removeItem("userInfo");
      localStorage.removeItem("token");
      disconnectSocket();
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        register,
        logout,
        loading,
      }}
    >
      {!loading && children}
    </AuthContext.Provider>
  );
};