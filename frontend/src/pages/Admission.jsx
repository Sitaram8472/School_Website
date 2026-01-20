import React, { useState } from "react";
import {
  FileText,
  CheckCircle2,
  CreditCard,
  UserCheck,
  Download,
  HelpCircle,
  ChevronDown,
  GraduationCap,
  ShieldCheck,
} from "lucide-react";

const Admissions = () => {
  const [openFaq, setOpenFaq] = useState(null);

  const steps = [
    {
      title: "Online Registration",
      desc: "Complete the digital application form and upload primary academic transcripts.",
      icon: <FileText className="w-6 h-6" />,
    },
    {
      title: "Aptitude Assessment",
      desc: "Candidates undergo a standardized evaluation covering logic, ethics, and core subjects.",
      icon: <ShieldCheck className="w-6 h-6" />,
    },
    {
      title: "Panel Interview",
      desc: "A formal interaction with our academic board to discuss goals and values.",
      icon: <UserCheck className="w-6 h-6" />,
    },
    {
      title: "Grant of Admission",
      desc: "Successful candidates receive an offer letter. Secure the seat by paying the enrollment fee.",
      icon: <CreditCard className="w-6 h-6" />,
    },
  ];

  const faqs = [
    {
      q: "What is the minimum age for Grade 1?",
      a: "The student must be 6 years old as of March 31st of the academic year.",
    },
    {
      q: "Is there a sibling discount?",
      a: "Yes, we offer a 10% waiver on the tuition fee for the younger sibling.",
    },
    {
      q: "What is the teacher-to-student ratio?",
      a: "We maintain a strict 1:25 ratio to ensure personalized attention.",
    },
  ];

  return (
    <div className="bg-white animate-in fade-in duration-700">
      {/* Hero Section */}
      <div className="relative bg-slate-900 py-28 px-4 overflow-hidden">
        <div className="absolute inset-0 opacity-20">
          <img
            src="https://images.unsplash.com/photo-1523050335392-93851179ae22?auto=format&fit=crop&w=1920"
            alt="Campus"
            className="w-full h-full object-cover"
          />
        </div>
        <div className="relative z-10 text-center">
          <span className="text-blue-400 font-bold tracking-widest uppercase text-sm">
            Admissions 2026-27
          </span>
          <h1 className="text-4xl md:text-6xl font-bold text-white mt-4 mb-6">
            Secure Your Future at EduStream
          </h1>
          <p className="text-slate-300 max-w-2xl mx-auto text-lg leading-relaxed">
            We are looking for the next generation of thinkers, creators, and
            leaders. Applications are now open for the upcoming academic
            session.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <button className="bg-blue-600 text-white px-8 py-4 rounded-lg font-bold hover:bg-blue-700 transition-all flex items-center justify-center gap-2">
              Apply Online Now
            </button>
            <button className="bg-white/10 text-white backdrop-blur-md border border-white/20 px-8 py-4 rounded-lg font-bold hover:bg-white/20 transition-all flex items-center justify-center gap-2">
              <Download size={20} /> Download Prospectus
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-20 sm:px-6 lg:px-8">
        {/* Requirements Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 mb-32 items-center">
          <div>
            <h2 className="text-3xl font-bold text-slate-900 mb-8">
              Eligibility & Requirements
            </h2>
            <div className="space-y-6">
              {[
                "Last 2 years' academic transcripts/report cards.",
                "Original Birth Certificate & Residence Proof.",
                "Transfer Certificate from the previous school.",
                "Pass-port size photographs (4 copies).",
                "Minimum 75% aggregate in previous grade (for High School).",
              ].map((item, i) => (
                <div key={i} className="flex items-center gap-4 text-slate-700">
                  <CheckCircle2
                    className="text-green-500 flex-shrink-0"
                    size={24}
                  />
                  <span className="text-lg">{item}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-slate-50 p-8 rounded-3xl border border-slate-200">
            <GraduationCap size={48} className="text-blue-600 mb-6" />
            <h3 className="text-2xl font-bold mb-4">Scholarship Programs</h3>
            <p className="text-slate-600 mb-6">
              We offer Merit-based Scholarships to exceptional students.
              Students scoring above 95% in their entrance assessment are
              eligible for a<strong> 50% Tuition Fee Waiver</strong>.
            </p>
            <button className="text-blue-600 font-bold hover:underline flex items-center gap-2">
              View Scholarship Criteria <ChevronDown size={16} />
            </button>
          </div>
        </div>

        {/* The Enrollment Process Timeline */}
        <div className="mb-32">
          <h2 className="text-3xl font-bold text-center mb-16 text-slate-900">
            The 4-Step Enrollment Journey
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            {steps.map((step, i) => (
              <div key={i} className="relative group">
                <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm hover:shadow-xl hover:border-blue-200 transition-all h-full">
                  <div className="w-14 h-14 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                    {step.icon}
                  </div>
                  <h3 className="text-xl font-bold mb-3 text-slate-900">
                    {step.title}
                  </h3>
                  <p className="text-slate-600 leading-relaxed text-sm">
                    {step.desc}
                  </p>
                </div>
                {i < 3 && (
                  <div className="hidden md:block absolute top-1/2 -right-4 transform -translate-y-1/2 text-slate-300">
                    <ChevronDown className="-rotate-90" size={32} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Admissions Calendar */}
        <div className="bg-slate-900 rounded-[3rem] p-8 md:p-16 text-white mb-32">
          <div className="text-center mb-12">
            <h3 className="text-3xl font-bold mb-4">
              Admissions Calendar 2026
            </h3>
            <p className="text-slate-400">
              Mark these important dates for the upcoming session.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              {
                label: "Applications Open",
                date: "March 15, 2026",
                color: "bg-blue-600",
              },
              {
                label: "Entrance Exam",
                date: "July 10, 2026",
                color: "bg-indigo-600",
              },
              {
                label: "Final Deadline",
                date: "August 05, 2026",
                color: "bg-emerald-600",
              },
            ].map((date, i) => (
              <div
                key={i}
                className={`${date.color} p-8 rounded-2xl text-center shadow-lg transform hover:-translate-y-2 transition-transform`}
              >
                <span className="text-xs uppercase tracking-widest opacity-80 font-bold">
                  {date.label}
                </span>
                <div className="text-2xl font-bold mt-2">{date.date}</div>
              </div>
            ))}
          </div>
        </div>

        {/* FAQ Section */}
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12 flex items-center justify-center gap-3">
            <HelpCircle className="text-blue-600" /> Frequently Asked Questions
          </h2>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <div
                key={i}
                className="border border-slate-200 rounded-xl overflow-hidden"
              >
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full p-5 text-left bg-white hover:bg-slate-50 flex justify-between items-center transition-colors"
                >
                  <span className="font-bold text-slate-800">{faq.q}</span>
                  <ChevronDown
                    className={`transition-transform ${openFaq === i ? "rotate-180" : ""}`}
                    size={20}
                  />
                </button>
                {openFaq === i && (
                  <div className="p-5 bg-slate-50 border-t border-slate-200 text-slate-600">
                    {faq.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Admissions;
