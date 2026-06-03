import React, { useEffect } from "react";
import {
  HashRouter as Router,
  Routes,
  Route,
  useLocation,
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
import DownloadProspectus from "./pages/DownloadProspectus";

/**
 * ScrollToTop ensures that every time a user navigates to a new page,
 * the window scrolls back to the top automatically.
 */
const ScrollToTop = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
};

const App = () => {
  return (
    <Router>
      {/* Helper to reset scroll position on navigation */}
      <ScrollToTop />

      {/* Main Layout Wrapper */}
      <div className="flex flex-col min-h-screen">
        {/* Navigation Bar */}
        <Navbar />

        {/* Page Content: This section grows to fill space, pushing Footer down */}
        <main className="grow">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/about" element={<About />} />
            <Route path="/teacher" element={<Teacher/>}/>
            <Route path="/academics" element={<Academics />} />
            <Route path="/admissions" element={<Admissions />} />
            <Route path="/gallery" element={<Gallery />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="/calendar" element={<EventCalendar />} />
            <Route path="/admissions/scholarship" element={<Scholarship />} />
            <Route path="/prospectus" element={<DownloadProspectus />} /> 
            <Route path="/student" element={<Student />} />
            
            {/* Catch-all route for 404 Page Not Found */}
            <Route path="*" element={<NotFound />} />
            
          </Routes>
        </main>

        {/* Site Footer */}
        <Footer />
      </div>
    </Router>
  );
};

export default App;
