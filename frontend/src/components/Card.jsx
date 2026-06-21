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
}) => {
  return (
    <div className="bg-[var(--card-bg)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
      
      {/* Image Section */}
      {image && (
        <div className="aspect-square relative overflow-hidden">
          <img
            src={image}
            alt={title}
            className="object-cover w-full h-full transform hover:scale-105 transition-transform duration-500"
          />

          {badge && (
            <span className="absolute top-3 right-3 bg-[var(--button-bg)] text-[var(--button-text)] text-xs font-bold px-2 py-1 rounded">
              {badge}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="p-5 flex-grow">
        
        {badge && !image && (
          <span className="inline-block mb-3 bg-[var(--bg-secondary)] text-[var(--text-secondary)] text-xs font-semibold px-2.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}

        <h3 className="text-xl font-bold text-[var(--text-primary)] mb-1">
          {title}
        </h3>

        {subtitle && (
          <p className="text-sm text-[var(--text-secondary)] mb-3">
            {subtitle}
          </p>
        )}

        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
          {content}
        </p>
      </div>

      {/* Footer */}
      {footer && (
        <div className="px-5 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-color)] text-xs font-medium text-[var(--text-secondary)]">
          {footer}
        </div>
      )}
    </div>
  );
};

export default Card;