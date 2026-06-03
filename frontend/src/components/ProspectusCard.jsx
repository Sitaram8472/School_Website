import React from "react";
import { Download, FileText } from "lucide-react";

/**
 * ProspectusCard — A reusable download card for the school prospectus.
 *
 * Props:
 *   - pdfUrl:      URL/import path to the PDF file
 *   - coverImage:  URL/import path to the prospectus cover thumbnail
 *   - title:       Card heading (default: "School Prospectus")
 *   - description: Short description text
 *   - variant:     "light" | "dark" — controls background styling
 */
const ProspectusCard = ({
  pdfUrl,
  coverImage,
  title = "School Prospectus",
  description = "Explore academics, facilities, admission process, and campus life.",
  variant = "light",
}) => {
  const isDark = variant === "dark";

  return (
    <div
      className={`group rounded-2xl p-6 flex items-center gap-6 transition-all duration-300 ${
        isDark
          ? "bg-white/10 backdrop-blur-md border border-white/20 hover:bg-white/20"
          : "bg-white border border-slate-200 shadow-sm hover:shadow-lg hover:border-blue-200"
      }`}
    >
      {/* Thumbnail */}
      {coverImage ? (
        <img
          src={coverImage}
          alt={`${title} Cover`}
          className="w-20 h-28 object-cover rounded-lg shadow-lg flex-shrink-0"
        />
      ) : (
        <div className="w-20 h-28 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
          <FileText className="text-blue-600" size={32} />
        </div>
      )}

      {/* Content */}
      <div className="text-left">
        <h3
          className={`font-bold text-lg mb-1 ${
            isDark ? "text-white" : "text-slate-900"
          }`}
        >
          {title}
        </h3>

        <p
          className={`text-sm mb-3 ${
            isDark ? "text-slate-300" : "text-slate-600"
          }`}
        >
          {description}
        </p>

        <a
          href={pdfUrl}
          download
          className="inline-flex items-center gap-2 bg-blue-600 px-4 py-2 rounded-lg text-white font-semibold hover:bg-blue-700 transition-colors text-sm"
          aria-label={`Download ${title} PDF`}
        >
          <Download size={18} />
          Download PDF
        </a>
      </div>
    </div>
  );
};

export default ProspectusCard;
