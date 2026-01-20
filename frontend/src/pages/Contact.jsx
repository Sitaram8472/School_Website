import { useState } from "react";
import { getAIResponse } from "../services/geminiService";
import {
  Mail,
  Phone,
  MapPin,
  Clock,
  Send,
  Sparkles,
  Loader2,
} from "lucide-react";

const Contact = () => {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const askAI = async () => {
    if (!question.trim()) return;
    setIsLoading(true);
    try {
      const res = await getAIResponse(question);
      setReply(res);
    // eslint-disable-next-line no-unused-vars
    } catch (error) {
      setReply(
        "Sorry, I'm having trouble connecting right now. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-slate-50 min-h-screen">
      {/* Hero Header */}
      <div className="bg-slate-900 py-16 px-4 text-center">
        <h1 className="text-4xl font-bold text-white mb-4">
          Contact Our Campus
        </h1>
        <p className="text-slate-400 max-w-xl mx-auto">
          Have questions? Our admissions team and AI assistant are here to help
          you navigate your journey at EduStream Academy.
        </p>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Column 1: Contact Details */}
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-slate-900 mb-6">
              Get in Touch
            </h2>

            {[
              {
                icon: <MapPin className="text-blue-600" />,
                title: "Our Location",
                detail: "123 Academic Drive, Salt Lake, Kolkata, West Bengal",
              },
              {
                icon: <Phone className="text-blue-600" />,
                title: "Phone Number",
                detail: "+91 33 2582 0000",
              },
              {
                icon: <Mail className="text-blue-600" />,
                title: "Email Address",
                detail: "admissions@edustream.edu",
              },
              {
                icon: <Clock className="text-blue-600" />,
                title: "Office Hours",
                detail: "Mon - Sat: 9:00 AM - 5:00 PM",
              },
            ].map((item, i) => (
              <div
                key={i}
                className="flex items-start p-4 bg-white rounded-xl shadow-sm border border-slate-100"
              >
                <div className="p-3 bg-blue-50 rounded-lg mr-4">
                  {item.icon}
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
                    {item.title}
                  </p>
                  <p className="text-slate-900 font-medium">{item.detail}</p>
                </div>
              </div>
            ))}

            {/* Google Maps Embed Placeholder */}
            <div className="rounded-xl overflow-hidden h-64 border border-slate-200 shadow-sm">
              <iframe
                title="School Map"
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3684.123456789!2d88.4!3d22.5!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMjLCsDMwJzAwLjAiTiA4OMKwMjQnMDAuMCJF!5e0!3m2!1sen!2sin!4v1625000000000!5m2!1sen!2sin"
                className="w-full h-full border-0"
                allowFullScreen=""
                loading="lazy"
              ></iframe>
            </div>
          </div>

          {/* Column 2 & 3: Inquiry & AI Support */}
          <div className="lg:col-span-2 space-y-8">
            {/* AI Assistant Section */}
            <div className="bg-white p-8 rounded-2xl shadow-md border border-blue-100 ring-4 ring-blue-50">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-blue-600 rounded-lg text-white">
                  <Sparkles size={24} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    EduStream AI Assistant
                  </h2>
                  <p className="text-sm text-slate-500">
                    Instant answers about admissions, fees, and courses.
                  </p>
                </div>
              </div>

              <div className="relative">
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  className="w-full p-4 pr-12 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all outline-none resize-none"
                  placeholder="Ask me anything, e.g., 'What are the admission requirements for 2026?'"
                  rows="3"
                />
                <button
                  onClick={askAI}
                  disabled={isLoading || !question.trim()}
                  className="absolute bottom-4 right-4 p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-slate-300 transition-colors"
                >
                  {isLoading ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <Send size={20} />
                  )}
                </button>
              </div>

              {reply && (
                <div className="mt-6 p-4 bg-blue-50 rounded-xl border border-blue-100 animate-in slide-in-from-top-2">
                  <p className="text-sm font-bold text-blue-800 mb-1">
                    AI Response:
                  </p>
                  <p className="text-slate-700 leading-relaxed">{reply}</p>
                </div>
              )}
            </div>

            {/* Traditional Form */}
            <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-xl font-bold text-slate-900 mb-6">
                Send an Official Inquiry
              </h2>
              <form className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input
                  type="text"
                  placeholder="Student Full Name"
                  className="p-3 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 transition-colors"
                />
                <input
                  type="email"
                  placeholder="Email Address"
                  className="p-3 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 transition-colors"
                />
                <select className="p-3 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 transition-colors md:col-span-2">
                  <option>Select Department</option>
                  <option>Admissions</option>
                  <option>Academic Affairs</option>
                  <option>Sports Department</option>
                  <option>Career Counseling</option>
                </select>
                <textarea
                  placeholder="How can we help you?"
                  rows="4"
                  className="p-3 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 transition-colors md:col-span-2 resize-none"
                />
                <button className="md:col-span-2 bg-slate-900 text-white py-3 rounded-lg font-semibold hover:bg-slate-800 transition-colors">
                  Submit Inquiry
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Contact;
