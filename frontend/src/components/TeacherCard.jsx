const TeacherCard = ({ teacher }) => {
  return (
    <div className="bg-[var(--card-bg)] rounded-xl shadow-sm border border-[var(--border-color)] overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
      
      {/* Image */}
      {teacher?.image && (
        <div className="aspect-square relative overflow-hidden">
          <img
            src={teacher.image}
            alt={teacher.name}
            className="object-cover w-full h-full transform hover:scale-105 transition-transform duration-500"
          />

          {teacher.department && (
            <span className="absolute top-3 right-3 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded">
              {teacher.department}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="p-5 flex-grow">
        <h3 className="text-xl font-bold text-[var(--text-primary)] mb-1">
          {teacher?.name}
        </h3>

        {teacher?.role && (
          <p className="text-sm font-medium text-blue-500 mb-3">
            {teacher.role}
          </p>
        )}

        <p className="text-[var(--text-secondary)] text-sm leading-relaxed mb-4">
          {teacher?.bio}
        </p>

        {/* Social Links */}
        {(teacher?.email || teacher?.linkedin) && (
          <div className="flex gap-3 pt-3 border-t border-[var(--border-color)]">
            
            {teacher?.email && (
              <a
                href={`mailto:${teacher.email}`}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-blue-500 transition-colors"
                title="Send Email"
              >
                Email
              </a>
            )}

            {teacher?.linkedin && (
              <a
                href={teacher.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-blue-600 transition-colors"
                title="LinkedIn Profile"
              >
                LinkedIn
              </a>
            )}

          </div>
        )}
      </div>
    </div>
  );
};

export default TeacherCard;