import React, { useState, useEffect } from "react";
import API from "../utils/axios";

// Sample Notice Data
export const notices = [
  {
    id: 1,
    title: "Example Notice",
    category: "General",
    content: "Content from database soon!",
    date: "2026-01-20",
  },
];

const Notices = () => {
  const [notices, setNotices] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadNotices = async () => {
      try {
        setLoading(true);

        const response = await API.get("/notices/all");

        setNotices(response.data);
      } catch (err) {
        console.error("Failed to fetch notices:", err);

        setError(
          err.response?.data?.message ||
            "Failed to load campus notices."
        );
      } finally {
        setLoading(false);
      }
    };

    loadNotices();
  }, []);

  if (loading) {
    return <p className="text-center">Loading notices...</p>;
  }

  return (
    <div>
      {error && (
        <p className="text-red-500 text-center mb-4">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {notices.map((notice) => (
          <div
            key={notice.id}
            className="p-4 border rounded shadow"
          >
            <h3 className="font-bold">{notice.title}</h3>

            <span className="text-blue-600 text-sm">
              {notice.category}
            </span>

            <p className="text-slate-600 mt-2">
              {notice.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Notices;