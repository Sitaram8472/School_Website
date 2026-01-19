import React from "react";

const Admissions = () => {
  const steps = [
    {
      title: "Application Submission",
      desc: "Fill out the online application form with personal and academic details.",
    },
    {
      title: "Entrance Assessment",
      desc: "Shortlisted candidates are invited for a comprehensive aptitude test.",
    },
    {
      title: "Personal Interview",
      desc: "Interaction with our faculty to understand student goals and potential.",
    },
    {
      title: "Final Enrollment",
      desc: "Verification of documents and payment of admission fees.",
    },
  ];

  return (
    <div className="animate-in fade-in duration-500">
      {/* Hero / Header Section */}
      <div className="bg-slate-50 py-24 px-4 text-center border-b border-slate-200">
        <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-6">
          Join EduStream
        </h1>
        <p className="text-slate-500 max-w-3xl mx-auto text-lg">
          We look for students who are curious, ambitious, and ready to
          contribute to our vibrant community.
        </p>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center mb-16">
          The Enrollment Process
        </h2>

        <div className="relative">
          {/* Vertical Timeline Line (Hidden on mobile) */}
          <div className="hidden md:block absolute left-1/2 transform -translate-x-1/2 h-full w-0.5 bg-blue-200 top-0"></div>

          <div className="space-y-12">
            {steps.map((step, i) => (
              <div
                key={i}
                className={`flex flex-col md:flex-row items-center ${i % 2 === 0 ? "md:flex-row-reverse" : ""}`}
              >
                {/* Content Card */}
                <div className="flex-1 md:w-1/2 flex justify-center md:justify-end md:px-12">
                  <div
                    className={`bg-white p-6 rounded-2xl shadow-sm border border-slate-200 w-full max-w-sm ${i % 2 === 0 ? "md:text-left" : "md:text-right"}`}
                  >
                    <div className="text-blue-600 font-bold mb-2">
                      Step {i + 1}
                    </div>
                    <h3 className="text-xl font-bold mb-2 text-slate-900">
                      {step.title}
                    </h3>
                    <p className="text-slate-600 text-sm">{step.desc}</p>
                  </div>
                </div>

                {/* Number Circle */}
                <div className="z-10 bg-blue-600 text-white w-10 h-10 rounded-full flex items-center justify-center font-bold my-4 md:my-0 shadow-lg">
                  {i + 1}
                </div>

                {/* Empty Spacer for Layout */}
                <div className="flex-1 md:w-1/2"></div>
              </div>
            ))}
          </div>
        </div>

        {/* Calendar / Call to Action Section */}
        <div className="mt-24 bg-blue-600 rounded-2xl p-8 md:p-12 text-center text-white">
          <h3 className="text-2xl font-bold mb-4">Admissions Calendar 2026</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-8">
            <div className="bg-blue-700 p-6 rounded-xl">
              <div className="text-sm uppercase tracking-widest opacity-80 mb-1">
                Applications Open
              </div>
              <div className="text-xl font-bold">March 15, 2026</div>
            </div>
            <div className="bg-blue-700 p-6 rounded-xl">
              <div className="text-sm uppercase tracking-widest opacity-80 mb-1">
                Application Deadline
              </div>
              <div className="text-xl font-bold">June 30, 2026</div>
            </div>
            <div className="bg-blue-700 p-6 rounded-xl">
              <div className="text-sm uppercase tracking-widest opacity-80 mb-1">
                Classes Begin
              </div>
              <div className="text-xl font-bold">August 25, 2026</div>
            </div>
          </div>

          <button className="mt-12 bg-white text-blue-600 px-10 py-4 rounded-full font-bold hover:bg-slate-100 transition-all shadow-lg active:scale-95">
            Download Prospectus
          </button>
        </div>
      </div>
    </div>
  );
};

export default Admissions;
