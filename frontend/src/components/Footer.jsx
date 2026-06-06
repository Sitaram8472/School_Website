import React from "react";
import { Link } from "react-router-dom";

const Footer = () => {
  return (
    <footer
      className="bg-[var(--bg-primary)] text-[var(--text-secondary)]"
    >
      <div className="max-w-7xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">

          {/* Logo and Description */}
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-xl">E</span>
              </div>
              <span className="text-[var(--text-primary)] text-xl font-bold">
                EduStream Academy
              </span>
            </div>

            <p className="max-w-xs text-[var(--text-secondary)]">
              Developing tomorrow's leaders through a culture of academic rigor, integrity, and lifelong learning.
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-[var(--text-primary)] font-semibold mb-4 uppercase tracking-wider text-sm">
              Quick Links
            </h4>

            <ul className="space-y-2">
              <li><Link to="/" className="hover:text-[var(--text-primary)] transition-colors">Home</Link></li>
              <li><Link to="/about" className="hover:text-[var(--text-primary)] transition-colors">About Us</Link></li>
              <li><Link to="/academics" className="hover:text-[var(--text-primary)] transition-colors">Academics</Link></li>
              <li><Link to="/admissions" className="hover:text-[var(--text-primary)] transition-colors">Admissions</Link></li>
            </ul>
          </div>

          {/* Contact Info */}
          <div>
            <h4 className="text-[var(--text-primary)] font-semibold mb-4 uppercase tracking-wider text-sm">
              Contact
            </h4>

            <ul className="space-y-2 text-sm">
              <li>123 Education Lane</li>
              <li>Academic District, ED 45678</li>
              <li>T: (555) 123-4567</li>
              <li>E: info@edustream.edu</li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-[var(--border-color)] flex flex-col md:flex-row justify-between items-center text-sm">
          <p>&copy; 2026 EduStream Academy. All rights reserved.</p>

          <div className="flex space-x-6 mt-4 md:mt-0">
            <a href="#" className="hover:text-[var(--text-primary)] transition-colors">
              Privacy Policy
            </a>
            <a href="#" className="hover:text-[var(--text-primary)] transition-colors">
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
