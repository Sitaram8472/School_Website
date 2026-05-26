import React from "react";

import {
  GraduationCap,
  BadgeDollarSign,
  Trophy,
  Sparkles,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { Link } from "react-router-dom";

function Scholarship() {
  const scholarships = [
    {
      title: "Merit-Based Scholarship",
      description:
        "Special rewards for students with outstanding academic performance and achievements.",
      icon: <GraduationCap size={34} />,
    },
    {
      title: "Need-Based Scholarship",
            description:
              "Financial assistance programs designed to support deserving students.",
            icon: <BadgeDollarSign size={34} />,

    },
    {
      title: "Special Talent Scholarship",
            description:
              "Recognition for excellence in sports, arts, leadership, and extracurricular activities.",
            icon: <Trophy size={34} />
    },
  ];


  const benefits = [
    "Reduced tuition fees",
    "Recognition in school events",
    "Access to premium learning resources",
    "Equal opportunities for every student",
  ];

  return (
    <div className="bg-slate-50 min-h-screen">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-slate-950 text-white">
        <div className="absolute inset-0 opacity-20">
          <img
            src="https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1600&q=80"
            alt="Scholarship"
            className="w-full h-full object-cover"
          />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-28 text-center">
          <div className="inline-flex items-center gap-2 bg-white/10 border border-white/20 px-5 py-2 rounded-full backdrop-blur-md mb-6">
            <Sparkles className="text-yellow-400" size={18} />
            <span className="text-sm tracking-wide uppercase font-semibold">
              Scholarship Programs 2026
            </span>
          </div>

          <h1 className="text-4xl md:text-6xl font-bold leading-tight max-w-4xl mx-auto">
            Empowering Dreams Through{" "}
            <span className="text-blue-400">Quality Education</span>
          </h1>

          <p className="text-slate-300 text-lg leading-relaxed max-w-3xl mx-auto mt-6">
            We are committed to supporting talented and deserving students
            through our Scholarship Programs. These scholarships reward
            dedication, academic excellence, creativity, and talent.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row justify-center gap-5">
            <Link
              to="/admissions"
              className="bg-blue-600 hover:bg-blue-700 transition-all px-8 py-4 rounded-xl font-semibold flex items-center justify-center gap-2 shadow-lg"
            >
              Apply for Scholarships
              <ArrowRight size={20} />
            </Link>

            <button className="border border-white/20 bg-white/10 hover:bg-white/20 transition-all px-8 py-4 rounded-xl font-semibold backdrop-blur-md">
              Explore Eligibility
            </button>
          </div>
        </div>
      </section>

      {/* Scholarship Cards */}
      <section className="max-w-7xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <span className="text-blue-600 font-semibold uppercase tracking-wider">
            Key Features
          </span>

          <h2 className="text-4xl font-bold text-slate-900 mt-4">
            Scholarship Opportunities
          </h2>

          <p className="text-slate-600 mt-4 max-w-2xl mx-auto text-lg">
            Supporting students through financial aid, academic rewards, and
            talent recognition programs.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {scholarships.map((item, index) => (
            <div
              key={index}
              className="group bg-white rounded-3xl p-8 border border-slate-200 hover:border-blue-200 hover:shadow-2xl transition-all duration-300"
            >
              <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-all">
                {item.icon}
              </div>

              <h3 className="text-2xl font-bold text-slate-900 mb-4">
                {item.title}
              </h3>

              <p className="text-slate-600 leading-relaxed">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Application Process */}
      <section className="bg-white py-24">
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <div>
            <span className="text-blue-600 uppercase tracking-widest font-semibold">
              Application Process
            </span>

            <h2 className="text-4xl font-bold text-slate-900 mt-4 mb-6">
              Simple & Transparent Process
            </h2>

            <p className="text-slate-600 text-lg leading-relaxed mb-8">
              Students can apply online with clear eligibility criteria and
              quick verification. Our mission is to make education accessible
              for every deserving learner.
            </p>

            <div className="space-y-5">
              {benefits.map((benefit, index) => (
                <div
                  key={index}
                  className="flex items-center gap-4 text-slate-700"
                >
                  <CheckCircle2 className="text-green-500" size={24} />
                  <span className="text-lg">{benefit}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 text-white rounded-[2rem] p-10 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-52 h-52 bg-blue-600 rounded-full blur-3xl opacity-20"></div>

            <div className="relative z-10">
              <div className="w-20 h-20 rounded-3xl bg-white/10 flex items-center justify-center mb-8">
                <GraduationCap size={42} className="text-blue-400" />
              </div>

              <h3 className="text-3xl font-bold mb-5">
                Build Your Bright Future
              </h3>

              <p className="text-slate-300 leading-relaxed mb-8">
                Apply for Scholarships Now and take the first step toward a
                brighter future with world-class learning opportunities.
              </p>

              <Link
                to="/admissions"
                className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 transition-all px-7 py-4 rounded-xl font-semibold"
              >
                Apply Now
                <ArrowRight size={18} />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default Scholarship;

