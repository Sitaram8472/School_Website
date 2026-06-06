import React from "react";
import { Download, FileText } from "lucide-react";

const ProspectusCard = ({
  pdfUrl,
  coverImage,
  title = "School Prospectus",
  description = "Explore academics, facilities, admission process, and campus life.",
}) => {
  return (
    <div
      className="group rounded-2xl p-6 flex items-center gap-6 transition-all duration-300
      bg-[var(--card-bg)] border border-[var(--border-color)]
      hover:shadow-lg"
    >
      {/* Thumbnail */}
      {coverImage ? (
        <img
          src={coverImage}
          alt={`${title} Cover`}
          className="w-20 h-28 object-cover rounded-lg shadow-lg flex-shrink-0"
        />
      ) : (
        <div className="w-20 h-28 bg-[var(--bg-secondary)] rounded-lg flex items-center justify-center flex-shrink-0">
          <FileText className="text-[var(--text-secondary)]" size={32} />
        </div>
      )}

      {/* Content */}
      <div className="text-left">
        <h3 className="font-bold text-lg mb-1 text-[var(--text-primary)]">
          {title}
        </h3>

        <p className="text-sm mb-3 text-[var(--text-secondary)]">
          {description}
        </p>

        <a
          href={pdfUrl}
          download
          className="inline-flex items-center gap-2 bg-blue-600 px-4 py-2 rounded-lg text-white font-semibold hover:bg-blue-700 transition-colors text-sm"
        >
          <Download size={18} />
          Download PDF
        </a>
      </div>
    </div>
  );
};

export default ProspectusCard;