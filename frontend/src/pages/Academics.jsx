import React from "react";

const Academics = () => {
  const programs = [
    {
      id: 1,
      title: "STEM Excellence",
      description:
        "Advanced curriculum in Physics, Chemistry, and Mathematics with hands-on lab experience.",
      duration: "4 Years",
      icon: "🔬",
    },
    {
      id: 2,
      title: "Digital Arts",
      description:
        "Exploring the fusion of traditional fine arts with modern digital media and 3D modeling.",
      duration: "3 Years",
      icon: "🎨",
    },
    {
      id: 3,
      title: "Business & Econ",
      description:
        "Developing entrepreneurial skills through real-world case studies and market analysis.",
      duration: "4 Years",
      icon: "📈",
    },
    {
      id: 4,
      title: "Humanities",
      description:
        "A deep dive into history, literature, and philosophy to understand the human experience.",
      duration: "4 Years",
      icon: "📚",
    },
  ];

  return (
    <div className="animate-in fade-in duration-500">
      {/* Header Section */}
      <div className="bg-blue-600 py-24 px-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-6">
          Academic Programs
        </h1>
        <p className="text-blue-100 max-w-3xl mx-auto text-lg">
          Diverse curriculum paths tailored to empower your specific interests
          and career goals.
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Programs Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-20">
          {programs.map((p) => (
            <div
              key={p.id}
              className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 flex items-start gap-6 hover:shadow-md transition-shadow"
            >
              <div className="text-4xl bg-slate-50 w-16 h-16 rounded-xl flex items-center justify-center flex-shrink-0">
                {p.icon}
              </div>
              <div>
                <h3 className="text-2xl font-bold text-slate-900 mb-2">
                  {p.title}
                </h3>
                <p className="text-slate-600 mb-4">{p.description}</p>
                <div className="flex items-center text-sm font-semibold text-blue-600">
                  <span className="bg-blue-50 px-3 py-1 rounded-full">
                    Duration: {p.duration}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Facilities Section */}
        <div className="bg-slate-50 rounded-3xl p-12 overflow-hidden relative">
          <div className="relative z-10 lg:w-1/2">
            <h2 className="text-3xl font-bold mb-6">
              State-of-the-Art Facilities
            </h2>
            <p className="text-slate-600 mb-8">
              We invest heavily in the best infrastructure to support our
              academic rigor. From high-end computing labs to advanced
              biological research facilities, EduStream provides everything a
              student needs to excel.
            </p>
            <ul className="space-y-3 mb-10">
              {[
                "Full-stack dev labs",
                "Smart classrooms",
                "Digital library (10k+ titles)",
                "Dedicated innovation hub",
              ].map((item, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 font-medium text-slate-700"
                >
                  <svg
                    className="h-5 w-5 text-green-500"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <img
            src="https://picsum.photos/seed/facility/800/600"
            className="hidden lg:block absolute -right-20 top-0 bottom-0 w-1/2 h-full object-cover transform rotate-3 scale-110 opacity-80"
            alt="School Facilities"
          />
        </div>
      </div>
    </div>
  );
};

export default Academics;
