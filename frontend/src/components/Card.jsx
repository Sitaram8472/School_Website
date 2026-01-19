import React from "react";

/**
 * Reusable Card component for Teachers, Notices, and Programs.
 */
const Card = ({
  title,
  subtitle,
  content,
  image,
  badge,
  footer,
  variant = "notice",
}) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
      {/* Top Image Section (Used mainly for Teacher cards) */}
      {image && (
        <div className="aspect-square relative overflow-hidden">
          <img
            src={image}
            alt={title}
            className="object-cover w-full h-full transform hover:scale-105 transition-transform duration-500"
          />
          {badge && (
            <span className="absolute top-3 right-3 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded">
              {badge}
            </span>
          )}
        </div>
      )}

      {/* Content Section */}
      <div className="p-5 flex-grow">
        {/* Badge for notice cards (when no image is present) */}
        {badge && !image && (
          <span className="inline-block mb-3 bg-blue-50 text-blue-700 text-xs font-semibold px-2.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}

        <h3 className="text-xl font-bold text-slate-900 mb-1">{title}</h3>

        {subtitle && (
          <p className="text-sm font-medium text-blue-600 mb-3">{subtitle}</p>
        )}

        <p className="text-slate-600 text-sm leading-relaxed">{content}</p>
      </div>

      {/* Footer Section (e.g., timestamps or metadata) */}
      {footer && (
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-xs font-medium text-slate-500">
          {footer}
        </div>
      )}
    </div>
  );
};

export default Card;
