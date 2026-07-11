import React, { useContext, useEffect } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
  Navigate,
} from "react-router-dom";

// Import Components
import Navbar from "./components/Navbar";
import Footer from "./components/Footer";
import EduStreamAssistant from "./components/EduStreamAssistant";

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
import VerifyEmail from "./pages/VerifyEmail";
import ResendVerification from "./pages/ResendVerification";
import VerifyEmailSent from "./pages/VerifyEmailSent";

import { AuthContext } from "./context/AuthContext";
import RoleProtectedRoute from "./components/RoleProtectedRoute";
import TeacherDashboard from "./pages/TeacherDashboard";
import ExamBuilder from "./pages/ExamBuilder";
import ExamTakingInterface from "./pages/ExamTakingInterface";
import SubmissionList from "./pages/SubmissionList";

const ScrollToTop = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
};

//  Protected Route - ONLY logged in users can access
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useContext(AuthContext);

  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

// Public Route - Only for non-logged in users (Login/Register)
const PublicRoute = ({ children }) => {
  const { user, loading } = useContext(AuthContext);

  if (loading) return null;

  if (user) {
    return <Navigate to="/home" replace />;
  }

  return children;
};

const App = () => {
  return (
    <Router>
      <ScrollToTop />

      <div className="flex flex-col min-h-screen">
        <Navbar />

        <main className="grow">
          <Routes>
            {/* Default route - public home */}
            <Route path="/" element={<Home />} />

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
            <Route path="/reset-password/:token" element={
              <PublicRoute>
                <ResetPassword />
              </PublicRoute>
            } />
            <Route path="/verify-email/:token" element={<VerifyEmail />} />
            <Route path="/resend-verification" element={<ResendVerification />} />
            <Route path="/verify-email-sent" element={<VerifyEmailSent />} />

            {/* Public Routes (No Login Required) */}
            <Route path="/home" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/academics" element={<Academics />} />
            <Route path="/admissions" element={<Admissions />} />
            <Route path="/admissions/scholarship" element={<Scholarship />} />
            <Route path="/gallery" element={<Gallery />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/calendar" element={<EventCalendar />} />
            <Route path="/prospectus" element={<DownloadProspectus />} />

            {/* Protected Routes - Role-Based (Login Required) */}
            <Route path="/teacher" element={
              <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                <Teacher />
              </RoleProtectedRoute>
            } />

            <Route path="/teacher/dashboard" element={
              <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                <TeacherDashboard />
              </RoleProtectedRoute>
            } />

            <Route path="/teacher/courses/:courseId/exam/new" element={
              <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                <ExamBuilder />
              </RoleProtectedRoute>
            } />

            <Route path="/teacher/exam/:examId/submissions" element={
              <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                <SubmissionList />
              </RoleProtectedRoute>
            } />

            <Route path="/student" element={
              <RoleProtectedRoute allowedRoles={["student"]}>
                <Student />
              </RoleProtectedRoute>
            } />

            <Route path="/student/exam/:examId" element={
              <RoleProtectedRoute allowedRoles={["student"]}>
                <ExamTakingInterface />
              </RoleProtectedRoute>
            } />

            {/* Catch-all route for 404 Page Not Found */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </main>

        <Footer />
      </div>

      <EduStreamAssistant />
    </Router>
  );
};

export default App;