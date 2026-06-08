import React, { useEffect } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  useLocation,
  Navigate,
} from "react-router-dom";

// Import Components
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";

// Import Pages
import Home from "./pages/Home";
import About from "./pages/About";
import Teacher from "./pages/Teacher";
import Academics from "./pages/Academics";
import Admissions from "./pages/Admission";
import Contact from "./pages/Contact";
import NotFound from "./pages/Notfound";
import EventCalendar from "./pages/EventCalendar";
import Scholarship from "./pages/Scholarship";
import Gallery from "./pages/Gallery";
import Student from "./pages/Student";
import Login from "./pages/Login";
import Register from "./pages/Register";
import DownloadProspectus from "./pages/DownloadProspectus";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";

import { AuthProvider } from "./context/AuthContext";

const ScrollToTop = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
};

// ✅ Protected Route - ONLY logged in users can access
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem("token");
  
  if (!token) {
    return <Navigate to="/register" replace />;
  }
  
  return children;
};

// ✅ Public Route - Only for non-logged in users (Login/Register)
const PublicRoute = ({ children }) => {
  const token = localStorage.getItem("token");
  
  if (token) {
    return <Navigate to="/home" replace />;
  }
  
  return children;
};

const App = () => {
  return (
    <AuthProvider>
      <Router>
        <ScrollToTop />

        <div className="flex flex-col min-h-screen">
          <Navbar />

          <main className="grow">
            <Routes>
              {/* Default route - protected home */}
              <Route path="/" element={
                <ProtectedRoute>
                  <Home />
                </ProtectedRoute>
              } />
              
              {/* Auth Routes - Public (only for non-logged in users) */}
              <Route path="/login" element={
                <PublicRoute>
                  <Login />
                </PublicRoute>
              } />
              <Route path="/login/:role" element={
                <PublicRoute>
                  <Login />
                </PublicRoute>
              } />
              <Route path="/register" element={
                <PublicRoute>
                  <Register />
                </PublicRoute>
              } />
              <Route path="/register/:role" element={
                <PublicRoute>
                  <Register />
                </PublicRoute>
              } />
              <Route path="/forgot-password" element={
                <PublicRoute>
                  <ForgotPassword />
                </PublicRoute>
              } />
              <Route path="/reset-password" element={
                <PublicRoute>
                  <ResetPassword />
                </PublicRoute>
              } />
              
              {/* Protected Routes (Need Login) */}
              <Route path="/home" element={
                <ProtectedRoute>
                  <Home />
                </ProtectedRoute>
              } />
              
              <Route path="/about" element={
                <ProtectedRoute>
                  <About />
                </ProtectedRoute>
              } />
              
              <Route path="/teacher" element={
                <ProtectedRoute>
                  <Teacher />
                </ProtectedRoute>
              } />
              
              <Route path="/academics" element={
                <ProtectedRoute>
                  <Academics />
                </ProtectedRoute>
              } />
              
              <Route path="/admissions" element={
                <ProtectedRoute>
                  <Admissions />
                </ProtectedRoute>
              } />
              
              <Route path="/gallery" element={
                <ProtectedRoute>
                  <Gallery />
                </ProtectedRoute>
              } />
              
              <Route path="/contact" element={
                <ProtectedRoute>
                  <Contact />
                </ProtectedRoute>
              } />
              
              <Route path="/calendar" element={
                <ProtectedRoute>
                  <EventCalendar />
                </ProtectedRoute>
              } />
              
              <Route path="/admissions/scholarship" element={
                <ProtectedRoute>
                  <Scholarship />
                </ProtectedRoute>
              } />
              
              <Route path="/prospectus" element={
                <ProtectedRoute>
                  <DownloadProspectus />
                </ProtectedRoute>
              } />
              
              <Route path="/student" element={
                <ProtectedRoute>
                  <Student />
                </ProtectedRoute>
              } />

              {/* Catch-all route for 404 Page Not Found */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </main>

          <Footer />
        </div>
      </Router>
    </AuthProvider>
  );
};

export default App;