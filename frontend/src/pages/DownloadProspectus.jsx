import React from "react";
import {
  Download,
  BookOpen,
  GraduationCap,
  Building2,
  Users,
  Trophy,
  CheckCircle2,
  FileText,
} from "lucide-react";

import prospectusPdf from "../assets/prospectus/prospectus.pdf";
import prospectusCover from "../assets/prospectus/prospectus-cover.jpg";

const DownloadProspectus = () => {
  const highlights = [
    {
      icon: <BookOpen className="w-6 h-6" />,
      title: "Academic Programs",
      desc: "Detailed overview of our STEM, Humanities, Arts, and Commerce streams.",
    },
    {
      icon: <Building2 className="w-6 h-6" />,
      title: "Campus & Facilities",
      desc: "Smart classrooms, research labs, sports complexes, and more.",
    },
    {
      icon: <Users className="w-6 h-6" />,
      title: "Faculty Profiles",
      desc: "Meet our 150+ experienced educators and mentors.",
    },
    {
      icon: <Trophy className="w-6 h-6" />,
      title: "Achievements",
      desc: "Our track record of academic excellence and student success.",
    },
  ];

  const includedSections = [
    "Vision, Mission & Core Values",
    "Curriculum Framework & Subjects Offered",
    "Admission Process & Fee Structure",
    "Scholarship & Financial Aid Programs",
    "Extracurricular Activities & Clubs",
    "Campus Infrastructure & Safety Policies",
    "Student Support & Counselling Services",
    "Alumni Network & Global Partnerships",
  ];

  return (
    <div className="bg-white animate-in fade-in duration-700">
      {/* Hero Section */}
      <div className="relative bg-slate-900 py-28 px-4 overflow-hidden">
        <div className="absolute inset-0 bg-blue-600/10 mix-blend-overlay"></div>
        <div className="relative z-10 text-center">
          <span className="text-blue-400 font-bold tracking-widest uppercase text-sm">
            Get to Know Us
          </span>
          <h1 className="text-4xl md:text-6xl font-bold text-white mt-4 mb-6">
            Download Our Prospectus
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed">
            Everything you need to know about EduStream Academy — our programs,
            campus, admissions, and more — in one comprehensive guide.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Main Download Section */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center mb-32">
          {/* Left — Prospectus Preview */}
          <div className="flex justify-center">
            <div className="relative group">
              <div className="absolute -inset-4 bg-blue-100 rounded-3xl -rotate-3 group-hover:rotate-0 transition-transform duration-500"></div>
              <img
                src={prospectusCover}
                alt="EduStream Academy Prospectus Cover"
                className="relative w-72 md:w-80 rounded-2xl shadow-2xl border-4 border-white object-cover"
              />
              <div className="absolute -bottom-4 -right-4 bg-blue-600 text-white px-4 py-2 rounded-xl text-sm font-bold shadow-lg flex items-center gap-2">
                <FileText size={16} />
                2026–27 Edition
              </div>
            </div>
          </div>

          {/* Right — Info & Download */}
          <div>
            <h2 className="text-3xl font-bold text-slate-900 mb-6">
              Your Complete Guide to EduStream Academy
            </h2>
            <p className="text-slate-600 leading-relaxed mb-8">
              Our prospectus provides an in-depth look at the academic
              excellence, campus life, and holistic development opportunities
              that make EduStream Academy a top choice for students and parents
              alike. Download your free copy to explore everything we offer.
            </p>

            {/* Key Info */}
            <div className="flex flex-wrap gap-6 mb-8 text-sm">
              <div className="flex items-center gap-2 text-slate-500">
                <FileText size={16} className="text-blue-600" />
                <span>PDF Format</span>
              </div>
              <div className="flex items-center gap-2 text-slate-500">
                <BookOpen size={16} className="text-blue-600" />
                <span>Comprehensive Guide</span>
              </div>
              <div className="flex items-center gap-2 text-slate-500">
                <GraduationCap size={16} className="text-blue-600" />
                <span>Academic Year 2026–27</span>
              </div>
            </div>

            {/* Download Button */}
            <a
              href={prospectusPdf}
              download
              className="inline-flex items-center gap-3 bg-blue-600 text-white px-8 py-4 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-xl hover:shadow-blue-600/30 active:scale-95"
              aria-label="Download EduStream Academy Prospectus PDF"
            >
              <Download size={22} />
              Download Prospectus
            </a>
          </div>
        </section>

        {/* What's Inside — Highlights Grid */}
        <section className="mb-32">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">
              What's Inside the Prospectus
            </h2>
            <p className="text-slate-500 max-w-2xl mx-auto">
              Get a preview of the key sections covered in our comprehensive
              school prospectus.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {highlights.map((item, i) => (
              <div
                key={i}
                className="group bg-white p-8 rounded-2xl border border-slate-100 shadow-sm hover:shadow-xl hover:border-blue-100 transition-all duration-300 text-center"
              >
                <div className="w-14 h-14 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center mx-auto mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors duration-300">
                  {item.icon}
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-3">
                  {item.title}
                </h3>
                <p className="text-slate-600 leading-relaxed text-sm">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Detailed Contents Checklist */}
        <section className="bg-slate-900 rounded-2xl sm:rounded-[3rem] p-6 sm:p-10 md:p-16 mb-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold text-white mb-8">
                Sections Covered in Detail
              </h2>
              <div className="space-y-5">
                {includedSections.map((section, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <CheckCircle2
                      className="text-blue-400 flex-shrink-0"
                      size={22}
                    />
                    <span className="text-slate-300 text-lg">{section}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center lg:text-right">
              <div className="inline-block bg-blue-600/20 backdrop-blur-sm border border-blue-500/30 rounded-3xl p-10">
                <GraduationCap size={64} className="text-blue-400 mx-auto mb-6" />
                <h3 className="text-2xl font-bold text-white mb-3">
                  Ready to Explore?
                </h3>
                <p className="text-slate-400 mb-8 max-w-sm mx-auto">
                  Download the prospectus now and take the first step towards
                  academic excellence.
                </p>
                <a
                  href={prospectusPdf}
                  download
                  className="inline-flex items-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-xl font-bold hover:bg-blue-700 transition-all active:scale-95"
                  aria-label="Download EduStream Academy Prospectus PDF"
                >
                  <Download size={20} />
                  Get Your Copy
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="text-center bg-blue-50 p-6 sm:p-12 rounded-3xl border border-blue-100">
          <BookOpen className="mx-auto text-blue-600 mb-6" size={48} />
          <h2 className="text-3xl font-bold text-slate-900 mb-4">
            Have Questions About Admissions?
          </h2>
          <p className="text-slate-600 max-w-2xl mx-auto mb-8">
            Our admissions team is here to help you every step of the way. Reach
            out to learn more about our programs and enrollment process.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <a
              href="#/contact"
              className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-xl font-bold hover:bg-blue-700 transition-all active:scale-95"
            >
              Contact Admissions
            </a>
            <a
              href="#/admissions"
              className="inline-flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-200 px-8 py-4 rounded-xl font-bold hover:bg-slate-50 transition-all active:scale-95"
            >
              View Admission Process
            </a>
          </div>
        </section>
      </div>
    </div>
  );
};

export default DownloadProspectus;
