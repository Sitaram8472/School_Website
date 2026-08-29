import React, { useContext, useEffect, Suspense, lazy } from "react";
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

// Import Pages (Lazy Loaded)
const Home = lazy(() => import("./pages/Home"));
const About = lazy(() => import("./pages/About"));
const Teacher = lazy(() => import("./pages/Teacher"));
const SportsBoard = lazy(() => import("./pages/SportsBoard"));
const SubstitutionBoard = lazy(() => import("./pages/SubstitutionBoard"));
const Academics = lazy(() => import("./pages/Academics"));
const Admissions = lazy(() => import("./pages/Admission"));
const Contact = lazy(() => import("./pages/Contact"));
const MeetingBooking = lazy(() => import("./pages/MeetingBooking"));
const NotFound = lazy(() => import("./pages/Notfound"));
const FieldTrips = lazy(() => import("./pages/FieldTrips"));
const EventCalendar = lazy(() => import("./pages/EventCalendar"));
const Scholarship = lazy(() => import("./pages/Scholarship"));
const Gallery = lazy(() => import("./pages/Gallery"));
const FeePortal = lazy(() => import("./pages/FeePortal"));
const Student = lazy(() => import("./pages/Student"));
const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const DownloadProspectus = lazy(() => import("./pages/DownloadProspectus"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail"));
const ResendVerification = lazy(() => import("./pages/ResendVerification"));
const VerifyEmailSent = lazy(() => import("./pages/VerifyEmailSent"));

import { AuthContext } from "./context/AuthContext";
import RoleProtectedRoute from "./components/RoleProtectedRoute";

const StaffTraining = lazy(() => import("./pages/StaffTraining"));

const TeacherDashboard = lazy(() => import("./pages/TeacherDashboard"));
const ExamBuilder = lazy(() => import("./pages/ExamBuilder"));
const RemarkAppeals = lazy(() => import("./pages/RemarkAppeals"));
const ExamTakingInterface = lazy(() => import("./pages/ExamTakingInterface"));
const SubmissionList = lazy(() => import("./pages/SubmissionList"));
const AdminAnalytics = lazy(() => import("./pages/AdminAnalytics"));

const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[50vh] text-2xl font-semibold text-gray-500">
    <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-blue-500 mr-4"></div>
    Loading...
  </div>
);

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

// Donations and fundraising. Declared as its own block rather than in the list
// above, so the module can be added or removed as one piece.
const GivingCampaigns = lazy(() => import("./pages/GivingCampaigns"));

const App = () => {
  return (
    <Router>
      <ScrollToTop />

      <div className="flex flex-col min-h-screen">
        <Navbar />

        <main className="grow">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* Default route - public home */}
             <Route path="/" element={<Navigate to="/student" replace />} />
  
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

              {/* Giving - any signed-in user pledges; admins run the ledger */}
              <Route path="/giving" element={
                <ProtectedRoute>
                  <GivingCampaigns />
                </ProtectedRoute>
              } />
              <Route path="/verify-email/:token" element={<VerifyEmail />} />
              <Route path="/resend-verification" element={<ResendVerification />} />
              <Route path="/verify-email-sent" element={<VerifyEmailSent />} />
  
              {/* Public Routes (No Login Required) */}
              <Route path="/home" element={<Home />} />

              {/* Inter-house sports - any signed-in user; staff record results */}
              <Route path="/sports" element={
                <ProtectedRoute>
                  <SportsBoard />
                </ProtectedRoute>
              } />

              {/* Substitute cover - teaching staff and admins */}
              <Route path="/substitutions" element={
                <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                  <SubstitutionBoard />
                </RoleProtectedRoute>
              } />

              <Route path="/about" element={<About />} />

              {/* Field trips - any signed-in family; staff also organise here */}
              <Route path="/trips" element={
                <ProtectedRoute>
                  <FieldTrips />
                </ProtectedRoute>
              } />

              <Route path="/academics" element={<Academics />} />
              <Route path="/admissions" element={<Admissions />} />
              <Route path="/admissions/scholarship" element={<Scholarship />} />
              <Route path="/gallery" element={<Gallery />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/calendar" element={<EventCalendar />} />
              <Route path="/prospectus" element={<DownloadProspectus />} />

              {/* Fees & payments - any signed-in user; staff see the admin panel */}
              <Route path="/fees" element={
                <ProtectedRoute>
                  <FeePortal />
                </ProtectedRoute>
              } />

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

              {/* Parent-teacher meeting booking - any signed-in family */}
              <Route path="/meetings" element={
                <ProtectedRoute>
                  <MeetingBooking />
                </ProtectedRoute>
              } />

              {/* Staff professional development - staff and admins */}
              <Route path="/staff/training" element={
                <RoleProtectedRoute allowedRoles={["teacher", "staff", "admin"]}>
                  <StaffTraining />
                </RoleProtectedRoute>
              } />

              <Route path="/admin/analytics" element={
                <RoleProtectedRoute allowedRoles={["admin", "staff"]}>
                  <AdminAnalytics />
                </RoleProtectedRoute>
              } />
  
              <Route path="/teacher/courses/:courseId/exam/new" element={
                <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                  <ExamBuilder />
                </RoleProtectedRoute>
              } />

              {/* Exam re-evaluation appeals - students appeal, staff review */}
              <Route path="/appeals" element={
                <ProtectedRoute>
                  <RemarkAppeals />
                </ProtectedRoute>
              } />
  
              <Route path="/teacher/exam/:examId/submissions" element={
                <RoleProtectedRoute allowedRoles={["teacher", "admin"]}>
                  <SubmissionList />
                </RoleProtectedRoute>
              } />
  
              <Route path="/student" element={<Student />} />
  
              <Route path="/student/exam/:examId" element={
                <RoleProtectedRoute allowedRoles={["student"]}>
                  <ExamTakingInterface />
                </RoleProtectedRoute>
              } />
  
              {/* Catch-all route for 404 Page Not Found */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>

        <Footer />
      </div>

      <EduStreamAssistant />
    </Router>
  );
};

export default App;