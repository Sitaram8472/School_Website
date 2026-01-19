import React from "react";
import { Link } from "react-router-dom";

const Notfound = () => {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center text-center px-4">
      {/* Background Stylized 404 */}
      <h1 className="text-9xl font-extrabold text-blue-600 opacity-20 select-none">
        404
      </h1>

      <div className="-mt-16 relative z-10">
        <h2 className="text-3xl font-bold text-slate-900 mb-4">
          Page Not Found
        </h2>
        <p className="text-slate-600 mb-8 max-w-md">
          The page you are looking for might have been removed, had its name
          changed, or is temporarily unavailable.
        </p>

        {/* Navigation Link */}
        <Link
          to="/"
          className="bg-blue-600 text-white px-8 py-3 rounded-full font-bold hover:bg-blue-700 transition-all inline-block shadow-lg active:scale-95"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
};

export default Notfound;
