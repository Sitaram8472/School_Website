import React from "react";
import Hero from "../components/Hero";
import Card from "../components/Card";
import Notices, { notices } from "../data/Notices";
import { teachers } from "../data/Teacher";
import {
  Users,
  GraduationCap,
  Library,
  Award,
  ChevronRight,
  ArrowRightCircle,
  Sparkles,
} from "lucide-react";

// Import images from your assets folder
import img1 from "../assets/campus/campus1.jpg";
import img2 from "../assets/campus/campus2.jpg";
import img3 from "../assets/campus/campus3.jpg";
import img4 from "../assets/campus/campus4.jpg";
import img5 from "../assets/campus/campus5.jpg";
import img6 from "../assets/campus/campus6.jpg";
import img7 from "../assets/campus/campus7.jpg";
import img8 from "../assets/campus/campus8.jpg";

const Home = () => {
  const galleryImages = [img1, img2, img3, img4, img5, img6, img7, img8];

  return (
    <div className="animate-in fade-in duration-700 bg-white">
      <Hero />

      {/* Statistics Section - Enhanced with Icons */}
      <section className="relative -mt-12 z-20 max-w-6xl mx-auto px-4">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-100 p-8 grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            {
              label: "Students",
              value: "1500+",
              icon: <Users className="text-blue-600" />,
            },
            {
              label: "Expert Faculty",
              value: "85+",
              icon: <GraduationCap className="text-blue-600" />,
            },
            {
              label: "Modern Labs",
              value: "24",
              icon: <Library className="text-blue-600" />,
            },
            {
              label: "Award Wins",
              value: "98%",
              icon: <Award className="text-blue-600" />,
            },
          ].map((stat, i) => (
            <div key={i} className="text-center space-y-2">
              <div className="flex justify-center">{stat.icon}</div>
              <div className="text-3xl font-bold text-slate-900">
                {stat.value}
              </div>
              <div className="text-slate-500 text-sm font-semibold uppercase tracking-wider">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Latest Notices */}
      <section className="py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center mb-16 gap-6">
            <div className="text-center md:text-left">
              <div className="flex items-center justify-center md:justify-start gap-2 text-blue-600 font-bold mb-2">
                <Sparkles size={18} />
                <span className="uppercase tracking-widest text-sm">
                  Updates
                </span>
              </div>
              <h2 className="text-4xl font-bold text-slate-900">
                Notice Board
              </h2>
            </div>
            <button className="group flex items-center gap-2 bg-white border border-slate-200 px-6 py-3 rounded-full text-slate-700 font-semibold hover:bg-blue-600 hover:text-white transition-all shadow-sm">
              View All Announcements{" "}
              <ChevronRight
                size={18}
                className="group-hover:translate-x-1 transition-transform"
              />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {notices.map((notice) => (
              <Card
                key={notice.id}
                title={notice.title}
                badge={notice.category}
                content={notice.content}
                footer={`Posted on ${new Date(notice.date).toLocaleDateString()}`}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Running Board (Infinite Image Marquee) */}
      <section className="py-12 bg-white overflow-hidden border-y border-slate-100">
        <div className="mb-8 text-center">
          <h3 className="text-xl font-bold text-slate-400 uppercase tracking-[0.3em]">
            Campus Life
          </h3>
        </div>
        <div className="relative flex overflow-x-hidden">
          <div className="animate-marquee flex gap-6">
            {galleryImages.map((img, index) => (
              <div
                key={index}
                className="w-[300px] h-[200px] rounded-2xl overflow-hidden shadow-lg flex-shrink-0 border-4 border-white"
              >
                <img
                  src={img}
                  alt={`Gallery ${index}`}
                  className="w-full h-full object-cover hover:scale-110 transition-transform duration-500"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Faculty */}
      <section className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <h2 className="text-4xl font-bold text-slate-900 mb-6">
              World-Class Educators
            </h2>
            <div className="w-24 h-1.5 bg-blue-600 mx-auto rounded-full mb-6"></div>
            <p className="text-slate-500 max-w-2xl mx-auto text-lg">
              Our faculty members bring a wealth of practical experience and
              academic rigor to the classroom.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10">
            {teachers.map((teacher) => (
              <Card
                key={teacher.id}
                variant="teacher"
                title={teacher.name}
                subtitle={teacher.role}
                content={teacher.bio}
                image={teacher.image}
                badge={teacher.department}
              />
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section - Professional Gradient */}
      <section className="py-24 px-4">
        <div className="max-w-6xl mx-auto bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 rounded-[3rem] p-12 md:p-20 text-center relative overflow-hidden shadow-2xl">
          <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl"></div>

          <h2 className="relative z-10 text-4xl md:text-5xl font-bold text-white mb-8">
            Ready to Shape Your Future?
          </h2>
          <p className="relative z-10 text-blue-100 text-lg mb-12 max-w-2xl mx-auto opacity-90">
            Admissions for the{" "}
            <span className="font-bold text-white underline decoration-blue-400">
              Academic Year 2026
            </span>{" "}
            are now open. Secure your spot in our vibrant learning community.
          </p>
          <div className="relative z-10 flex flex-col sm:flex-row gap-6 justify-center">
            <button className="flex items-center justify-center gap-2 bg-blue-600 text-white px-10 py-4 rounded-xl font-bold hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/30 transition-all active:scale-95">
              Start Application <ArrowRightCircle size={20} />
            </button>
            <button className="bg-white/10 backdrop-blur-md text-white border border-white/20 px-10 py-4 rounded-xl font-bold hover:bg-white/20 transition-all active:scale-95">
              Inquire Now
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
