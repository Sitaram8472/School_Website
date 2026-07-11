import { NavLink, useNavigate } from "react-router-dom";
import { useState, useContext, useRef, useCallback } from "react";
import { AuthContext } from "../context/AuthContext";
import { getUserRole } from "../utils/permissions";

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState(null);
  // Controls the desktop "Get Started" dropdown via state instead of pure CSS
  // so it stays open while the pointer travels from the button into the menu.
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const closeTimer = useRef(null);

  const { user, logout } = useContext(AuthContext);
  const navigate = useNavigate();
  const isLoggedIn = !!user;
  const role = getUserRole(user);

  const navLinks = [
    { name: "Home", path: "/" },
    { name: "About", path: "/about" },
    { name: "Academics", path: "/academics" },
    { name: "Contact", path: "/contact" },
    { name: "Calendar", path: "/calendar" },
    { name: "Gallery", path: "/gallery" },
    ...(role === "student" ? [{ name: "Student", path: "/student" }] : []),
    ...(role === "teacher" || role === "admin"
      ? [{ name: "Teacher Dashboard", path: "/teacher/dashboard" }]
      : []),
  ];

  const handleLogout = async () => {
    await logout(); // ✅ Wait for logout to finish before navigating away
    navigate("/");
  };

  // --- Dropdown helpers (mouse + keyboard) ---
  // A small delay prevents the dropdown from closing when the pointer
  // crosses the gap between the trigger button and the menu panel.
  const openDropdown = useCallback(() => {
    clearTimeout(closeTimer.current);
    setIsDropdownOpen(true);
  }, []);

  const scheduleClose = useCallback(() => {
    closeTimer.current = setTimeout(() => setIsDropdownOpen(false), 120);
  }, []);

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

      <nav className="bg-blue-600 border-b border-blue-500 sticky top-0 z-50 shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            {/* Logo Section */}
            <div className="flex items-center">
              <NavLink to="/" className="flex items-center gap-2">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                  <span className="text-blue-600 font-bold text-xl">E</span>
                </div>
                <span className="text-xl font-bold text-white tracking-tight">
                  EduStream
                </span>
              </NavLink>
            </div>

            {/* Desktop Links */}
            <div className="hidden md:flex items-center space-x-4 lg:space-x-8">
              {navLinks.map((link) => (
                <NavLink key={link.name} to={link.path}>
                  {({ isActive }) => (
                    <div className="relative pb-1 group">
                      <span
                        className={`font-medium transition-colors duration-300 ${
                          isActive ? "text-white" : "text-blue-50 group-hover:text-white"
                        }`}
                      >
                        {link.name}
                      </span>
                      <span
                        className={`absolute bottom-0 left-0 w-full h-0.5 bg-white transition-transform duration-300 ease-out ${
                          isActive ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"
                        }`}
                      />
                    </div>
                  )}
                </NavLink>
              ))}

              {/* Auth — based on login status */}
              {!isLoggedIn ? (
                // Dropdown wrapper — open/close driven by React state so the
                // pointer can travel freely from trigger → menu without flicker.
                // onFocus/onBlur ensure keyboard (Tab) users can also access it.
                <div
                  className="relative"
                  onMouseEnter={openDropdown}
                  onMouseLeave={scheduleClose}
                  onFocus={openDropdown}
                  onBlur={scheduleClose}
                >
                  <div className="button-bg rounded-full p-0.5 hover:scale-105 transition duration-300 active:scale-95 cursor-pointer shadow-lg">
                    <button
                      aria-haspopup="true"
                      aria-expanded={isDropdownOpen}
                      className="px-5 py-2 text-white rounded-full font-semibold bg-slate-900 flex items-center gap-2 text-sm"
                    >
                      Get Started
                      <svg
                        className={`w-4 h-4 transition-transform duration-200 ${isDropdownOpen ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>

                  {/* Dropdown panel */}
                  {isDropdownOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 mt-2 w-48 bg-white border border-slate-100 rounded-xl shadow-2xl z-50 overflow-hidden"
                    >
                      <NavLink
                        to="/login"
                        role="menuitem"
                        className="block px-4 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 font-medium border-b border-slate-100 focus:outline-none focus:bg-blue-50"
                        onClick={() => setIsDropdownOpen(false)}
                      >
                        Sign In
                      </NavLink>
                      <NavLink
                        to="/register"
                        role="menuitem"
                        className="block px-4 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 font-medium focus:outline-none focus:bg-blue-50"
                        onClick={() => setIsDropdownOpen(false)}
                      >
                        Sign Up
                      </NavLink>
                    </div>
                  )}
                </div>
              ) : (
                <button onClick={handleLogout} className="px-5 py-2 text-white rounded-full font-semibold bg-red-600 hover:bg-red-700 transition shadow-md">
                  Logout
                </button>
              )}
            </div>

            {/* Mobile Menu Button */}
            <div className="md:hidden flex items-center">
              <button onClick={() => setIsOpen(!isOpen)} className="text-white focus:outline-none">
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {isOpen ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  )}
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        {isOpen && (
          <div className="md:hidden bg-blue-700 border-t border-blue-500 py-4 px-4 space-y-1">
            {navLinks.map((link) => (
              <NavLink
                key={link.name}
                to={link.path}
                onClick={() => setIsOpen(false)}
                className={({ isActive }) =>
                  `block px-3 py-2 rounded-md text-base font-medium transition-all duration-300 ${
                    isActive ? "bg-blue-800 text-white border-l-4 border-white" : "text-blue-50 hover:bg-blue-600"
                  }`
                }
              >
                {link.name}
              </NavLink>
            ))}
            
            <div className="pt-4 mt-2 border-t border-blue-500">
              {!isLoggedIn ? (
                <>
                  <button onClick={() => setActiveDropdown(activeDropdown === "auth" ? null : "auth")} className="w-full text-left px-3 py-2 text-base font-bold text-white flex justify-between items-center">
                    GET STARTED <span>{activeDropdown === "auth" ? "−" : "+"}</span>
                  </button>
                  {activeDropdown === "auth" && (
                    <div className="space-y-1 pl-4">
                      <NavLink to="/login" onClick={() => setIsOpen(false)} className="block pl-4 py-2 text-blue-100 text-sm hover:text-white">Sign In</NavLink>
                      <NavLink to="/register" onClick={() => setIsOpen(false)} className="block pl-4 py-2 text-blue-100 text-sm hover:text-white">Sign Up</NavLink>
                    </div>
                  )}
                </>
              ) : (
                <button onClick={() => { handleLogout(); setIsOpen(false); }} className="w-full px-3 py-2 text-center text-white font-semibold bg-red-600 rounded-md hover:bg-red-700 transition">
                  Logout
                </button>
              )}
            </div>
          </div>
        )}
      </nav>
    </>
  );
};

export default Navbar;