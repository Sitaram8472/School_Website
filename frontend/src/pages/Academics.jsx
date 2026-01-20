import React from "react";
import {
  BookOpen,
  Cpu,
  Palette,
  LineChart,
  FlaskConical,
  Globe2,
  CheckCircle2,
  ArrowRight,
  GraduationCap,
} from "lucide-react";

const Academics = () => {
  const departments = [
    {
      title: "STEM & Innovation",
      icon: <Cpu className="w-8 h-8" />,
      description:
        "Rigorous training in robotics, advanced mathematics, and computational thinking.",
      subjects: [
        "Quantum Physics",
        "AI & Robotics",
        "Calculus BC",
        "Organic Chemistry",
      ],
      color: "blue",
    },
    {
      title: "Digital Arts & Design",
      icon: <Palette className="w-8 h-8" />,
      description:
        "Bridging the gap between classical aesthetics and modern digital production.",
      subjects: [
        "3D Modeling",
        "UX/UI Design",
        "Art History",
        "Digital Cinematography",
      ],
      color: "purple",
    },
    {
      title: "Economics & Global Trade",
      icon: <LineChart className="w-8 h-8" />,
      description:
        "Preparing future leaders for the complexities of global markets and entrepreneurship.",
      subjects: [
        "Macroeconomics",
        "Game Theory",
        "Business Ethics",
        "Market Analysis",
      ],
      color: "emerald",
    },
    {
      title: "Humanities & Law",
      icon: <Globe2 className="w-8 h-8" />,
      description:
        "Critical analysis of social structures, literature, and international legal frameworks.",
      subjects: [
        "World Philosophy",
        "Constitutional Law",
        "Linguistics",
        "Political Science",
      ],
      color: "orange",
    },
  ];

  return (
    <div className="bg-white animate-in fade-in duration-700">
      {/* Hero Section */}
      <div className="bg-slate-900 py-28 px-4 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-blue-600/10 mix-blend-overlay"></div>
        <div className="relative z-10">
          <span className="text-blue-400 font-bold tracking-widest uppercase text-sm">
            Academic Excellence
          </span>
          <h1 className="text-4xl md:text-6xl font-bold text-white mt-4 mb-6">
            Our Academic Programs
          </h1>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed">
            EduStream Academy offers a world-class curriculum designed to foster
            intellectual curiosity and prepare students for the world's most
            prestigious universities.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Learning Philosophy Section */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-32">
          {[
            {
              title: "Experiential Learning",
              desc: "We believe in 'learning by doing' through lab work, field trips, and real-world projects.",
              icon: <FlaskConical className="text-blue-600" />,
            },
            {
              title: "Global Perspective",
              desc: "Our curriculum is mapped to international standards, preparing students for a global career.",
              icon: <Globe2 className="text-blue-600" />,
            },
            {
              title: "Individual Mentorship",
              desc: "Small class sizes allow for personalized academic paths tailored to each student's strengths.",
              icon: <GraduationCap className="text-blue-600" />,
            },
          ].map((item, i) => (
            <div key={i} className="text-center">
              <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
                {item.icon}
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-3">
                {item.title}
              </h3>
              <p className="text-slate-600 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>

        {/* Departments Grid */}
        <div className="mb-32">
          <h2 className="text-3xl font-bold text-slate-900 mb-12 text-center">
            Academic Departments
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {departments.map((dept, i) => (
              <div
                key={i}
                className="group bg-white p-10 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl hover:border-blue-100 transition-all duration-300"
              >
                <div className="flex justify-between items-start mb-8">
                  <div className="p-4 bg-slate-50 rounded-2xl text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors duration-300">
                    {dept.icon}
                  </div>
                  <span className="text-slate-300 font-mono text-xl">
                    0{i + 1}
                  </span>
                </div>
                <h3 className="text-2xl font-bold text-slate-900 mb-4">
                  {dept.title}
                </h3>
                <p className="text-slate-600 mb-8 leading-relaxed">
                  {dept.description}
                </p>

                <div className="border-t border-slate-50 pt-8">
                  <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">
                    Core Subjects
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {dept.subjects.map((sub, j) => (
                      <span
                        key={j}
                        className="px-4 py-2 bg-slate-50 text-slate-700 rounded-full text-sm font-medium border border-slate-100"
                      >
                        {sub}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Facilities Section */}
        <div className="bg-slate-900 rounded-[3rem] overflow-hidden">
          <div className="flex flex-col lg:flex-row">
            <div className="p-12 lg:p-20 lg:w-1/2">
              <h2 className="text-3xl font-bold text-white mb-8">
                World-Class Learning Infrastructure
              </h2>
              <div className="space-y-6">
                {[
                  {
                    title: "Smart Research Labs",
                    detail: "Equipped with the latest IoT and AI hardware.",
                  },
                  {
                    title: "The Great Library",
                    detail:
                      "Access to 50,000+ digital journals and physical rare editions.",
                  },
                  {
                    title: "Collaborative Hubs",
                    detail:
                      "Open-plan spaces designed for group innovation and debates.",
                  },
                ].map((f, i) => (
                  <div key={i} className="flex gap-4">
                    <CheckCircle2 className="text-blue-500 mt-1 flex-shrink-0" />
                    <div>
                      <h4 className="text-white font-bold">{f.title}</h4>
                      <p className="text-slate-400 text-sm">{f.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
              <button className="mt-12 flex items-center gap-2 text-blue-400 font-bold hover:text-blue-300 transition-colors">
                Explore Our Campus <ArrowRight size={20} />
              </button>
            </div>
            <div className="lg:w-1/2 h-[400px] lg:h-auto">
              <img
                src="https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=1200"
                className="w-full h-full object-cover"
                alt="Modern School Architecture"
              />
            </div>
          </div>
        </div>

        {/* Academic Outcome Section */}
        <div className="mt-32 text-center bg-blue-50 p-12 rounded-3xl border border-blue-100">
          <BookOpen className="mx-auto text-blue-600 mb-6" size={48} />
          <h2 className="text-3xl font-bold text-slate-900 mb-4">
            Academic Excellence Guaranteed
          </h2>
          <p className="text-slate-600 max-w-2xl mx-auto mb-8">
            Our graduates are currently studying at Ivy League universities and
            leading institutions worldwide. We don't just teach for exams; we
            teach for life.
          </p>
          <div className="flex justify-center gap-8">
            <div>
              <div className="text-3xl font-bold text-blue-600">100%</div>
              <div className="text-sm text-slate-500 font-medium">
                University Placement
              </div>
            </div>
            <div className="w-px h-12 bg-blue-200"></div>
            <div>
              <div className="text-3xl font-bold text-blue-600">92%</div>
              <div className="text-sm text-slate-500 font-medium">
                Distinction Rate
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Academics;
