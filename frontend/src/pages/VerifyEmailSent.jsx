import React from "react";
import { Link } from "react-router-dom";

const VerifyEmailSent = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center">
        <h2 className="text-3xl font-bold text-gray-800 mb-4">
          Registration successful
        </h2>
        <p className="text-gray-600 mb-6">
          Please check your inbox to verify your account before logging in.
        </p>

        <div className="flex justify-center gap-3">
          <Link
            to="/resend-verification"
            className="px-4 py-2 bg-gray-200 rounded-lg text-gray-700 hover:bg-gray-300 transition"
          >
            Resend Email
          </Link>
          <Link
            to="/login"
            className="px-4 py-2 bg-blue-600 rounded-lg text-white hover:bg-blue-700 transition"
          >
            Go to Login
          </Link>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmailSent;
