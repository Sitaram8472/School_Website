import React, { useState, useEffect } from "react";
import API from "../utils/axios";
import Card from "../components/Card";
import { getSocket } from "../utils/socket";

// Fallback notice data in case the backend is unreachable
export const notices = [
  {
    id: 1,
    title: "Summer Vacation 2026",
    category: "Academic",
    content: "The academy will remain closed for summer break starting June 1st, 2026. Online remedial sessions start June 15th.",
    date: "2026-05-20",
  },
];

const Notices = () => {
  const [dbNotices, setDbNotices] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadNotices = async () => {
      try {
        setLoading(true);

        const response = await API.get("/notices");
        
        // Handle both raw array and wrapper payload { success, data }
        const noticeList = response.data?.data || response.data || [];
        setDbNotices(noticeList);
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

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewNotice = (notice) => {
      setDbNotices((prevNotices) => [notice, ...prevNotices]);
    };

    socket.on("newNotice", handleNewNotice);

    return () => {
      socket.off("newNotice", handleNewNotice);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-10 w-full col-span-full">
        <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Use local fallback if backend has an error or is empty
  const displayList = dbNotices.length > 0 ? dbNotices : notices;

  return (
    <div className="w-full">
      {error && (
        <p className="text-red-500 text-xs text-center mb-6 bg-red-50 p-2.5 rounded-xl border border-red-100 max-w-md mx-auto">
          {error} (Using offline notice backup)
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
        {displayList.map((notice) => (
          <Card
            key={notice._id || notice.id}
            title={notice.title}
            badge={notice.category}
            content={notice.content}
            footer={`Posted on ${new Date(notice.date).toLocaleDateString()}`}
          />
        ))}
      </div>
    </div>
  );
};

export default Notices;