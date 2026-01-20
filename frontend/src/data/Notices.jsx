import React, { useState, useEffect } from "react";
import API from "../api/axios"; // Import the instance we just made

// Make sure you have the word 'export' before 'const notices'
export const notices = [
  {
    id: 1,
    title: "Example Notice",
    category: "General",
    content: "Content from database soon!",
    date: "2026-01-20"
  }
];

const Notices = () => {
  const [notices, setNotices] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadNotices = async () => {
      try {
        const response = await API.get("/notices/all");
        setNotices(response.data);
      } catch (err) {
        setError("Failed to load campus notices.");
        console.error(err);
      }
    };
    loadNotices();
  }, []);

  return (
    <div>
      {error && <p className="text-red-500">{error}</p>}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {notices.map((notice) => (
          <div key={notice.id} className="p-4 border rounded shadow">
            <h3 className="font-bold">{notice.title}</h3>
            <span className="text-blue-600 text-sm">{notice.category}</span>
            <p className="text-slate-600 mt-2">{notice.content}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Notices;