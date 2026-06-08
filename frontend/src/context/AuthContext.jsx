import React, { createContext, useState, useEffect } from "react";
import api from "../utils/axios";

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Load user from localStorage
  useEffect(() => {
    try {
      const userInfo = localStorage.getItem("userInfo");

      if (userInfo) {
        setUser(JSON.parse(userInfo));
      }
    } catch (error) {
      console.error("Failed to load user from localStorage:", error);

      localStorage.removeItem("userInfo");
      localStorage.removeItem("token");
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

      setUser(data);

      localStorage.setItem("userInfo", JSON.stringify(data));
      localStorage.setItem("token", data.token);

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

  // Register Function - Supports both with and without role
  const register = async (name, email, password, role = "student") => {
    try {
      const { data } = await api.post("/auth/register", {
        name,
        email,
        password,
        role,
      });

      // Save token and user after registration
      if (data.token) {
        setUser(data);
        localStorage.setItem("userInfo", JSON.stringify(data));
        localStorage.setItem("token", data.token);
      }

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
  const logout = () => {
    try {
      setUser(null);

      localStorage.removeItem("userInfo");
      localStorage.removeItem("token");
    } catch (error) {
      console.error("Logout Error:", error);
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