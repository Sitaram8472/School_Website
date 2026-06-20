import React, { useState, useEffect } from "react";
import API from "../utils/axios";
import { Search, Download, BookOpen, FileText, Video } from "lucide-react";

const AcademicResourceHub = () => {
  const [resources, setResources] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchResources = async () => {
      try {
        const response = await API.get("/resources");
        const resData = response.data?.data || response.data || [];
        setResources(resData);
      } catch (error) {
        console.error("Failed to load resources:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchResources();
  }, []);

  const filteredResources = resources.filter(
    (res) =>
      res.title.toLowerCase().includes(search.toLowerCase()) ||
      res.subject.toLowerCase().includes(search.toLowerCase())
  );

  const getIcon = (type) => {
    if (type?.includes("video")) return <Video className="text-purple-500 w-8 h-8" />;
    if (type?.includes("pdf")) return <FileText className="text-red-500 w-8 h-8" />;
    return <BookOpen className="text-blue-500 w-8 h-8" />;
  };

  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-extrabold text-[var(--text-primary)] mb-4">
            Academic Resource Hub
          </h1>
          <p className="text-lg text-[var(--text-secondary)]">
            Centralized repository for course materials and STEM excellence programs.
          </p>
        </div>

        {/* Search Bar */}
        <div className="max-w-xl mx-auto mb-10">
          <div className="relative">
            <Search className="absolute left-4 top-3.5 text-slate-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Search by title or subject..."
              className="w-full pl-12 pr-4 py-3 rounded-2xl border border-slate-200 bg-[var(--card-bg)] text-[var(--text-primary)] shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center py-20">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {filteredResources.length > 0 ? (
              filteredResources.map((res) => (
                <div
                  key={res._id}
                  className="bg-[var(--card-bg)] rounded-3xl p-6 shadow-xl border border-slate-100 hover:shadow-2xl transition-all hover:-translate-y-1 group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="bg-blue-50 dark:bg-slate-800 p-3 rounded-2xl group-hover:scale-110 transition-transform">
                      {getIcon(res.fileType)}
                    </div>
                    <span className="text-xs font-semibold px-3 py-1 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-full">
                      {res.subject}
                    </span>
                  </div>
                  <h3 className="text-xl font-bold text-[var(--text-primary)] mb-2">
                    {res.title}
                  </h3>
                  <p className="text-sm text-[var(--text-secondary)] mb-6">
                    Uploaded by {res.teacherName || "Admin"} • {res.targetClass}
                  </p>
                  
                  <a
                    href={`http://localhost:5000${res.fileUrl}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 bg-blue-50 text-blue-600 dark:bg-slate-800 dark:text-blue-400 font-semibold rounded-xl hover:bg-blue-600 hover:text-white dark:hover:bg-blue-600 dark:hover:text-white transition-colors"
                  >
                    <Download className="w-5 h-5" /> Download
                  </a>
                </div>
              ))
            ) : (
              <div className="col-span-full text-center py-10 text-[var(--text-secondary)]">
                No resources found matching your search.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default AcademicResourceHub;
