import React from "react";
import { Users, BookOpen, Trophy, Globe, Award, Calendar } from "lucide-react";

const About = () => {
  return (
    <div className="animate-in fade-in duration-500 bg-slate-50">
      {/* Hero Section */}
      <div className="bg-slate-900 py-24 px-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-6">
          About EduStream Academy
        </h1>
        <p className="text-slate-400 max-w-3xl mx-auto text-lg">
          A legacy of academic excellence since 1985, committed to holistic
          development and global impact. We don't just teach; we inspire the
          leaders of tomorrow.
        </p>
      </div>

      {/* School Memories Section */}
      <div className="mt-32">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-slate-900 mb-4">
            Life at EduStream: Captured Moments
          </h2>
          <p className="text-slate-500 max-w-2xl mx-auto">
            From the classroom to the field, take a look at the experiences that
            shape our students' journey.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              url: "https://images.unsplash.com/photo-1523050335392-93851179ae22?auto=format&fit=crop&w=800&q=80",
              title: "Graduation Day",
              size: "col-span-2 row-span-2",
            },
            {
              url: "https://images.unsplash.com/photo-1509062522246-3755977927d7?auto=format&fit=crop&w=800&q=80",
              title: "Smart Classrooms",
              size: "col-span-1",
            },
            {
              url: "https://images.unsplash.com/photo-1577894779850-f4ca9201f9d7?auto=format&fit=crop&w=800&q=80",
              title: "Science Lab",
              size: "col-span-1",
            },
            {
              url: "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=800&q=80",
              title: "Sports Meet",
              size: "col-span-1 row-span-1",
            },
            {
              url: "https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&w=800&q=80",
              title: "Library",
              size: "col-span-1 row-span-1",
            },
            {
              url: "https://images.unsplash.com/photo-1511629091441-ee461463a2cd?auto=format&fit=crop&w=800&q=80",
              title: "Annual Fest",
              size: "col-span-2",
            },
          ].map((img, i) => (
            <div
              key={i}
              className={`relative group overflow-hidden rounded-2xl bg-slate-200 ${img.size}`}
            >
              <img
                src={img.url}
                alt={img.title}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
              />
              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-6">
                <p className="text-white font-semibold text-lg">{img.title}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-32">
          {[
            {
              label: "Students",
              value: "2,500+",
              icon: <Users className="w-6 h-6" />,
            },
            {
              label: "Expert Faculty",
              value: "150+",
              icon: <BookOpen className="w-6 h-6" />,
            },
            {
              label: "Awards Won",
              value: "45+",
              icon: <Trophy className="w-6 h-6" />,
            },
            {
              label: "Global Partners",
              value: "12",
              icon: <Globe className="w-6 h-6" />,
            },
          ].map((stat, i) => (
            <div
              key={i}
              className="text-center p-6 bg-white rounded-2xl shadow-sm border border-slate-100"
            >
              <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-50 text-blue-600 rounded-lg mb-4">
                {stat.icon}
              </div>
              <div className="text-3xl font-bold text-slate-900">
                {stat.value}
              </div>
              <div className="text-slate-500 font-medium">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Mission Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-center mb-32">
          <div>
            <h2 className="text-3xl font-bold text-slate-900 mb-6 flex items-center gap-2">
              <Award className="text-blue-600" /> Our Mission
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

          <div className="grid grid-cols-2 gap-4">
            <img
              src="https://picsum.photos/seed/about1/400/500"
              className="rounded-2xl shadow-lg transform -rotate-2 hover:rotate-0 transition-transform duration-300"
              alt="Campus Life"
            />
            <img
              src="https://picsum.photos/seed/about2/400/500"
              className="rounded-2xl shadow-lg mt-8 transform rotate-2 hover:rotate-0 transition-transform duration-300"
              alt="Students Learning"
            />
          </div>
        </div>

        {/* Leadership Team */}
        <div className="mb-32">
          <h2 className="text-3xl font-bold text-slate-900 text-center mb-12">
            Our Leadership
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                name: "Dr. Sarah Jenkins",
                role: "Principal",
                img: "https://i.pravatar.cc/150?u=sarah",
              },
              {
                name: "Michael Chen",
                role: "Vice Principal",
                img: "https://i.pravatar.cc/150?u=chen",
              },
              {
                name: "Emily Rodriguez",
                role: "Dean of Academics",
                img: "https://i.pravatar.cc/150?u=emily",
              },
            ].map((leader, i) => (
              <div
                key={i}
                className="bg-white p-6 rounded-2xl text-center shadow-sm hover:shadow-md transition-shadow"
              >
                <img
                  src={leader.img}
                  alt={leader.name}
                  className="w-24 h-24 rounded-full mx-auto mb-4 border-4 border-blue-50"
                />
                <h3 className="text-xl font-bold text-slate-900">
                  {leader.name}
                </h3>
                <p className="text-blue-600 font-medium">{leader.role}</p>
              </div>
            ))}
          </div>
        </div>

        {/* History Timeline */}
        <div className="mb-32">
          <h2 className="text-3xl font-bold text-slate-900 text-center mb-12 flex justify-center items-center gap-2">
            <Calendar className="text-blue-600" /> Our Journey
          </h2>
          <div className="space-y-8">
            {[
              {
                year: "1985",
                event: "Foundation of EduStream Academy with just 50 students.",
              },
              {
                year: "2002",
                event:
                  "Awarded 'National School of Excellence' for the first time.",
              },
              {
                year: "2015",
                event:
                  "Inauguration of our state-of-the-art Science & Tech Wing.",
              },
              {
                year: "2023",
                event: "Expanded to global digital learning platforms.",
              },
            ].map((milestone, i) => (
              <div key={i} className="flex gap-6 items-start">
                <div className="font-bold text-blue-600 text-xl pt-1 min-w-[60px]">
                  {milestone.year}
                </div>
                <div className="pb-8 border-l-2 border-slate-200 pl-8 relative">
                  <div className="absolute w-3 h-3 bg-blue-600 rounded-full -left-[7.5px] top-3"></div>
                  <p className="text-slate-600 text-lg">{milestone.event}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Core Values */}
        <div>
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
