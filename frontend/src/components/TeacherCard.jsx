const TeacherCard = ({ teacher }) => {  // ✅ Sirf teacher prop lo
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
      {/* Top Image Section */}
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

      {/* Content Section */}
      <div className="p-5 flex-grow">
        <h3 className="text-xl font-bold text-slate-900 mb-1">{teacher?.name}</h3>

        {teacher?.role && (
          <p className="text-sm font-medium text-blue-600 mb-3">{teacher.role}</p>
        )}

        <p className="text-slate-600 text-sm leading-relaxed mb-4">{teacher?.bio}</p>

        {/* Social Links Section */}
        {(teacher?.email || teacher?.linkedin) && (
          <div className="flex gap-3 pt-3 border-t border-slate-100">
            {teacher?.email && (
              <a
                href={`mailto:${teacher.email}`}
                className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600 transition-colors"
                title="Send Email"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
                Email
              </a>
            )}
            {teacher?.linkedin && (
              <a
                href={teacher.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-700 transition-colors"
                title="LinkedIn Profile"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                </svg>
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




//   return (
//     <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow flex flex-col h-full">
//       {/* Top Image Section */}
//       {teacher.image && (
//         <div className="aspect-square relative overflow-hidden">
//           <img
//             src={teacher.image}
//             alt={teacher.name}
//             className="object-cover w-full h-full transform hover:scale-105 transition-transform duration-500"
//           />
//           {teacher.department && (
//             <span className="absolute top-3 right-3 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded">
//               {teacher.department}
//             </span>
//           )}
//         </div>
//       )}

//       {/* Content Section */}
//       <div className="p-5 flex-grow">
//         <h3 className="text-xl font-bold text-slate-900 mb-1">{teacher.name}</h3>

//         {teacher.role && (
//           <p className="text-sm font-medium text-blue-600 mb-3">{teacher.role}</p>
//         )}

//         <p className="text-slate-600 text-sm leading-relaxed mb-4">{teacher.bio}</p>

//         {/* Social Links Section */}
//         {(teacher.email || teacher.linkedin) && (
//           <div className="flex gap-3 pt-3 border-t border-slate-100">
//             {teacher.email && (
//               <a
//                 href={`mailto:${teacher.email}`}
//                 className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600 transition-colors"
//                 title="Send Email"
//               >
//                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
//                     d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
//                   />
//                 </svg>
//                 Email
//               </a>
//             )}
//             {teacher.linkedin && (
//               <a
//                 href={teacher.linkedin}
//                 target="_blank"
//                 rel="noopener noreferrer"
//                 className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-700 transition-colors"
//                 title="LinkedIn Profile"
//               >
//                 <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
//                   <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
//                 </svg>
//                 LinkedIn
//               </a>
//             )}
//           </div>
//         )}
//       </div>
//     </div>
//   );
// };

// export default Card;