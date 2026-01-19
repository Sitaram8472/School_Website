import React from "react";

const About = () => {
  return (
    <div className="animate-in fade-in duration-500">
      {/* Hero Section */}
      <div className="bg-slate-900 py-24 px-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-6">
          About EduStream Academy
        </h1>
        <p className="text-slate-400 max-w-3xl mx-auto text-lg">
          A legacy of academic excellence since 1985, committed to holistic
          development and global impact.
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Mission Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          <div>
            <h2 className="text-3xl font-bold text-slate-900 mb-6">
              Our Mission
            </h2>
            <p className="text-slate-600 mb-6 leading-relaxed">
              At EduStream, we believe that education is more than just academic
              achievement. It's about fostering curiosity, critical thinking,
              and character. Our mission is to provide an inclusive environment
              where every student is challenged to reach their full potential.
            </p>
            <p className="text-slate-600 leading-relaxed">
              We integrate traditional academic values with modern technological
              advancements, ensuring our students are not only prepared for
              university but for a rapidly changing global landscape.
            </p>
          </div>

          {/* Image Grid */}
          <div className="grid grid-cols-2 gap-4">
            <img
              src="https://picsum.photos/seed/about1/400/500"
              className="rounded-2xl shadow-lg"
              alt="Campus Life"
            />
            <img
              src="https://picsum.photos/seed/about2/400/500"
              className="rounded-2xl shadow-lg mt-8"
              alt="Students Learning"
            />
          </div>
        </div>

        {/* Core Values Section */}
        <div className="mt-32">
          <h2 className="text-3xl font-bold text-slate-900 text-center mb-12">
            Our Core Values
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                title: "Integrity",
                desc: "We uphold the highest ethical standards in all aspects of school life.",
              },
              {
                title: "Innovation",
                desc: "We embrace new ideas and technologies to enhance the learning experience.",
              },
              {
                title: "Inclusion",
                desc: "We celebrate diversity and ensure every voice is heard and valued.",
              },
            ].map((v, i) => (
              <div
                key={i}
                className="bg-white p-8 rounded-xl border border-slate-200 text-center hover:border-blue-300 transition-colors"
              >
                <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-xl mx-auto mb-6">
                  {i + 1}
                </div>
                <h3 className="text-xl font-bold mb-4">{v.title}</h3>
                <p className="text-slate-600">{v.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default About;
