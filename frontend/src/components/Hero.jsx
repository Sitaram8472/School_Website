import React from "react";
import { Link } from "react-router-dom";

const Hero = () => {
  return (
    <div className="relative bg-[var(--bg-primary)] overflow-hidden">
      <div className="max-w-7xl mx-auto">
        <div className="relative z-10 pb-8 bg-[var(--bg-primary)] sm:pb-16 md:pb-20 lg:max-w-2xl lg:w-full lg:pb-28 xl:pb-32">

          {/* Decorative Slanted Edge */}
          <svg
            className="hidden lg:block absolute right-0 inset-y-0 h-full w-48 text-[var(--bg-primary)] transform translate-x-1/2"
            fill="currentColor"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polygon points="50,0 100,0 50,100 0,100" />
          </svg>

          <main className="mt-10 mx-auto max-w-7xl px-4 sm:mt-12 sm:px-6 md:mt-16 lg:mt-20 lg:px-8 xl:mt-28">
            <div className="sm:text-center lg:text-left">

              <h1 className="text-4xl tracking-tight font-extrabold text-[var(--text-primary)] sm:text-5xl md:text-6xl">
                <span className="block xl:inline">
                  Building Future Leaders Through
                  Quality Education & Innovation
                </span>{" "}
                <span className="block text-blue-500 xl:inline">
                  Excellence
                </span>
              </h1>

              <p className="mt-3 text-base text-[var(--text-secondary)] sm:mt-5 sm:text-lg sm:max-w-xl sm:mx-auto md:mt-5 md:text-xl lg:mx-0">
                Join EduStream Academy, where excellence meets innovation. We
                provide a transformative learning experience that prepares
                students for global challenges.
              </p>

              {/* Buttons */}
              <div className="mt-5 sm:mt-8 sm:flex sm:justify-center lg:justify-start">

                <div className="rounded-md shadow">
                  <Link
                    to="/admissions"
                    className="w-full flex items-center justify-center px-8 py-4 text-base font-semibold rounded-xl border border-slate-300 bg-white hover:bg-slate-50 transition-all"
                  >
                    Start Admission
                  </Link>
                </div>

                <div className="mt-3 sm:mt-0 sm:ml-3">
                  <Link
                    to="/academics"
                    className="w-full flex items-center justify-center px-8 py-3 text-base font-medium rounded-md text-[var(--text-primary)] bg-[var(--card-bg)] border border-[var(--border-color)] hover:opacity-80 md:py-4 md:text-lg md:px-10"
                  >
                    View Programs
                  </Link>
                </div>

              </div>
            </div>
          </main>
        </div>
      </div>

      {/* Image */}
      <div className="lg:absolute lg:inset-y-0 lg:right-0 lg:w-1/2">
        <img
          className="h-56 w-full object-cover sm:h-72 md:h-96 lg:w-full lg:h-full"
          src="https://picsum.photos/seed/school/1200/800"
          alt="Students studying"
        />
      </div>
    </div>
  );
};

export default Hero;