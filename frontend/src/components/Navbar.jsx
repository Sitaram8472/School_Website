import { NavLink } from "react-router-dom";
import { useState, useContext, useEffect } from "react";
import { AuthContext } from "../context/AuthContext";
import { Sun, Moon } from "lucide-react";

const Navbar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [isDark, setIsDark] = useState(false);
  
  const { user, logout } = useContext(AuthContext);
  const isLoggedIn = !!user;  // true if user exists

  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme === "dark") {
      setIsDark(true);
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      setIsDark(false);
      document.documentElement.removeAttribute("data-theme");
    }
  }, []);

  const toggleTheme = () => {
    if (isDark) {
      setIsDark(false);
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("theme", "light");
    } else {
      setIsDark(true);
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("theme", "dark");
    }
  };

  const navLinks = [
    { name: "Home", path: "/home" },
    { name: "About", path: "/about" },
    { name: "Teacher", path: "/teacher" },
    { name: "Academics", path: "/academics" },
    { name: "Contact", path: "/contact" },
    { name: "Calendar", path: "/calendar" },
    { name: "Resources", path: "/resources" },
    { name: "Gallery", path: "/gallery" },
    { name: "Student", path: "/student" },
  ];

  const handleLogout = () => {
    logout();  // ✅ This clears context + localStorage
    window.location.href = "/register";
  };

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

      <nav className="bg-blue-600/90 backdrop-blur-md border-b border-blue-500/50 sticky top-0 z-50 shadow-md transition-all">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            {/* Logo Section */}
            <div className="flex items-center">
              <NavLink to="/home" className="flex items-center gap-2">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-inner">
                  <span className="text-blue-600 font-bold text-xl">E</span>
                </div>
                <span className="text-xl font-bold text-white tracking-tight">
                  EduStream
                </span>
              </NavLink>
            </div>

            {/* Desktop Links */}
            <div className="hidden md:flex items-center space-x-4 lg:space-x-6">
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

              <button onClick={toggleTheme} className="p-2 ml-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors" aria-label="Toggle Dark Mode">
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>

              {/* ✅ Based on login status */}
              {!isLoggedIn ? (
                <div className="relative group ml-2">
                  <div className="button-bg rounded-full p-0.5 hover:scale-105 transition duration-300 active:scale-95 cursor-pointer shadow-lg">
                    <button className="px-5 py-2 text-white rounded-full font-semibold bg-slate-900 flex items-center gap-2 text-sm">
                      Get Started
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>
                  <div className="absolute right-0 mt-3 w-48 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl shadow-2xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 overflow-hidden">
                    <NavLink to="/login" className="block px-4 py-3 text-slate-700 dark:text-slate-200 hover:bg-blue-50 dark:hover:bg-slate-700 hover:text-blue-600 dark:hover:text-blue-400 font-medium border-b border-slate-100 dark:border-slate-700">
                      Sign In
                    </NavLink>
                    <NavLink to="/register" className="block px-4 py-3 text-slate-700 dark:text-slate-200 hover:bg-blue-50 dark:hover:bg-slate-700 hover:text-blue-600 dark:hover:text-blue-400 font-medium">
                      Sign Up
                    </NavLink>
                  </div>
                </div>
              ) : (
                <button onClick={handleLogout} className="px-5 py-2 ml-2 text-white rounded-full font-semibold bg-red-600/90 hover:bg-red-700 transition shadow-md hover:shadow-red-500/30">
                  Logout
                </button>
              )}
            </div>

            {/* Mobile Menu Button */}
            <div className="md:hidden flex items-center gap-4">
              <button onClick={toggleTheme} className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors" aria-label="Toggle Dark Mode">
                {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
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
          <div className="md:hidden bg-blue-700/95 backdrop-blur-md border-t border-blue-500/50 py-4 px-4 space-y-1">
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
            
            <div className="pt-4 mt-2 border-t border-blue-500/50">
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