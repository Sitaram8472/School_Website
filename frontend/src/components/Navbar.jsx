import React, { useState } from "react";
import { Link } from "react-router-dom";

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState(null);

  const navLinks = [
    { name: "Home", path: "/" },
    { name: "About", path: "/about" },
    { name: "Academics", path: "/academics" },
    { name: "Contact", path: "/contact" },
  ];

  const roles = [
    { name: "Student", path: "/student" },
    { name: "Teacher", path: "/teacher" },
    { name: "Staff", path: "/staff" },
  ];

  return (
    <>
      <style>{`
        @keyframes shine {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .button-bg {
          background: conic-gradient(from 0deg, #00F5FF, #FF00C7, #FFD700, #00FF85, #8A2BE2, #00F5FF);
          background-size: 300% 300%;
          animation: shine 4s ease-out infinite;
        }
      `}</style>

      {/* Changed bg-white to bg-blue-600 and updated border */}
      <nav className="bg-blue-600 border-b border-blue-500 sticky top-0 z-50 shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            {/* Logo Section */}
            <div className="flex items-center">
              <Link to="/" className="flex items-center gap-2">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                  <span className="text-blue-600 font-bold text-xl">E</span>
                </div>
                {/* Logo text changed to white for contrast */}
                <span className="text-xl font-bold text-white tracking-tight">
                  EduStream
                </span>
              </Link>
            </div>

            {/* Desktop Links - Changed text color to white */}
            <div className="hidden md:flex items-center space-x-8">
              {navLinks.map((link) => (
                <Link
                  key={link.name}
                  to={link.path}
                  className="text-blue-50 hover:text-white transition-colors font-medium"
                >
                  {link.name}
                </Link>
              ))}

              {/* Animated Dropdown Button */}
              <div className="relative group">
                <div className="button-bg rounded-full p-[2px] hover:scale-105 transition duration-300 active:scale-95 cursor-pointer shadow-lg">
                  <button className="px-5 py-2 text-white rounded-full font-semibold bg-slate-900 flex items-center gap-2 text-sm">
                    Get Started
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                </div>

                {/* Dropdown Menu (Stays White for readability) */}
                <div className="absolute right-0 mt-3 w-52 bg-white border border-slate-100 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 py-2">
                  <div className="relative group/sub">
                    <div className="px-4 py-2.5 text-slate-700 hover:bg-blue-50 hover:text-blue-600 cursor-pointer flex justify-between items-center font-medium">
                      Sign In <span className="text-[10px] opacity-50">▶</span>
                    </div>
                    <div className="absolute left-full top-0 ml-1 w-44 bg-white border border-slate-100 rounded-xl shadow-xl opacity-0 invisible group-hover/sub:opacity-100 group-hover/sub:visible transition-all py-2">
                      {roles.map((role) => (
                        <Link
                          key={`in-${role.name}`}
                          to={`/login${role.path}`}
                          className="block px-4 py-2 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-600"
                        >
                          As {role.name}
                        </Link>
                      ))}
                    </div>
                  </div>

                  <div className="relative group/sub">
                    <div className="px-4 py-2.5 text-slate-700 hover:bg-blue-50 hover:text-blue-600 cursor-pointer flex justify-between items-center font-medium border-t border-slate-50">
                      Sign Up <span className="text-[10px] opacity-50">▶</span>
                    </div>
                    <div className="absolute left-full top-0 ml-1 w-44 bg-white border border-slate-100 rounded-xl shadow-xl opacity-0 invisible group-hover/sub:opacity-100 group-hover/sub:visible transition-all py-2">
                      {roles.map((role) => (
                        <Link
                          key={`up-${role.name}`}
                          to={`/register${role.path}`}
                          className="block px-4 py-2 text-sm text-slate-600 hover:bg-blue-50 hover:text-blue-600"
                        >
                          Register as {role.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Mobile Menu Button - Changed to white */}
            <div className="md:hidden flex items-center">
              <button
                onClick={() => setIsOpen(!isOpen)}
                className="text-white focus:outline-none"
              >
                <svg
                  className="h-7 w-7"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  {isOpen ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu Dropdown - Matching Blue Theme */}
        {isOpen && (
          <div className="md:hidden bg-blue-700 border-t border-blue-500 py-4 px-4 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                to={link.path}
                onClick={() => setIsOpen(false)}
                className="block px-3 py-2 rounded-md text-base font-medium text-blue-50 hover:bg-blue-600"
              >
                {link.name}
              </Link>
            ))}
            <div className="pt-4 mt-2 border-t border-blue-500">
              <button
                onClick={() =>
                  setActiveDropdown(
                    activeDropdown === "signin" ? null : "signin",
                  )
                }
                className="w-full text-left px-3 py-2 text-base font-bold text-white flex justify-between items-center"
              >
                SIGN IN <span>{activeDropdown === "signin" ? "−" : "+"}</span>
              </button>
              {activeDropdown === "signin" &&
                roles.map((role) => (
                  <Link
                    key={`m-in-${role.name}`}
                    to={`/login${role.path}`}
                    onClick={() => setIsOpen(false)}
                    className="block pl-8 py-2 text-blue-100 text-sm hover:text-white"
                  >
                    Login as {role.name}
                  </Link>
                ))}

              <button
                onClick={() =>
                  setActiveDropdown(
                    activeDropdown === "signup" ? null : "signup",
                  )
                }
                className="w-full text-left px-3 py-2 text-base font-bold text-white flex justify-between items-center mt-2"
              >
                SIGN UP <span>{activeDropdown === "signup" ? "−" : "+"}</span>
              </button>
              {activeDropdown === "signup" &&
                roles.map((role) => (
                  <Link
                    key={`m-up-${role.name}`}
                    to={`/register${role.path}`}
                    onClick={() => setIsOpen(false)}
                    className="block pl-8 py-2 text-blue-100 text-sm hover:text-white"
                  >
                    Register as {role.name}
                  </Link>
                ))}
            </div>
          </div>
        )}
      </nav>
    </>
  );
};

export default Navbar;
