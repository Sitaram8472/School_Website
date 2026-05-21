import api from "../utils/axios";

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
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

const Contact = () => {
  // ---------------- AI Assistant State ----------------
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // ---------------- Inquiry Form State ----------------
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    department: "",
    message: "",
  });

  const [formLoading, setFormLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  // ---------------- AI Assistant Function ----------------
  const askAI = async () => {
    if (!question.trim()) return;

    setIsLoading(true);

    try {
      const res = await getAIResponse(question);
      setReply(res); // eslint-disable-next-line no-unused-vars
    } catch (error) {
      console.error(error);

      setReply(
        "Sorry, I'm having trouble connecting right now. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  // ---------------- Handle Input Change ----------------
  const handleChange = (e) => {
    const { name, value } = e.target;

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    // Clear messages while typing
    setError("");
    setSuccess("");
  };

  // ---------------- Email Validation ----------------
  const validateEmail = (email) => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  // ---------------- Form Submit ----------------
  const handleSubmit = async (e) => {
    e.preventDefault();

    setError("");
    setSuccess("");

    // Validation
    if (!formData.name.trim()) {
      return setError("Full name is required.");
    }

    if (!validateEmail(formData.email)) {
      return setError("Please enter a valid email address.");
    }

    if (!formData.department) {
      return setError("Please select a department.");
    }

    if (!formData.message.trim()) {
      return setError("Message field cannot be empty.");
    }

    try {
      setFormLoading(true);

      // ---------------- API CALL ----------------
      // Replace with real backend API
      const response = await api.post("/inquiries", formData);
      console.log(response?.data);
      setSuccess(
        "Your inquiry has been submitted successfully. Our team will contact you soon.",
      );

      // Reset Form
      setFormData({
        name: "",
        email: "",
        department: "",
        message: "",
      });
    } catch (err) {
      console.error(err?.response);

      setError(
        "Something went wrong while submitting your inquiry. Please try again.",
      );
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <div className="bg-slate-50 min-h-screen">
      {/* ---------------- Hero Section ---------------- */}
      <div className="bg-linear-to-r from-slate-950 via-slate-900 to-blue-950 py-20 px-4 text-center">
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-5">
          Contact Our Campus
        </h1>

        <p className="text-slate-300 max-w-2xl mx-auto leading-relaxed text-lg">
          Have questions? Our admissions team and AI assistant are here to help
          guide your journey at EduStream Academy.
        </p>
      </div>

      {/* ---------------- Main Content ---------------- */}
      <div className="max-w-7xl mx-auto px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* ========================================================= */}
          {/* LEFT COLUMN */}
          {/* ========================================================= */}

          <div className="space-y-6">
            <h2 className="text-3xl font-bold text-slate-900">
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
                className="flex items-start gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all"
              >
                <div className="p-3 bg-blue-50 rounded-xl">
                  {item.icon}
                </div>

                <div>
                  <p className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
                    {item.title}
                  </p>

                  <p className="text-slate-900 font-medium mt-1">
                    {item.detail}
                  </p>
                </div>
              </div>
            ))}

            {/* Google Map */}
            <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-sm h-72">
              <iframe
                title="School Location"
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3684.123456789!2d88.4!3d22.5!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMjLCsDMwJzAwLjAiTiA4OMKwMjQnMDAuMCJF!5e0!3m2!1sen!2sin!4v1625000000000!5m2!1sen!2sin"
                className="w-full h-full border-0"
                loading="lazy"
                allowFullScreen=""
              />
            </div>
          </div>

          {/* ========================================================= */}
          {/* RIGHT COLUMN */}
          {/* ========================================================= */}

          <div className="lg:col-span-2 space-y-8">
            {/* ---------------- AI Assistant ---------------- */}

            <div className="bg-white p-8 rounded-3xl border border-blue-100 shadow-md ring-4 ring-blue-50">
              <div className="flex items-center gap-4 mb-6">
                <div className="bg-blue-600 text-white p-3 rounded-xl">
                  <Sparkles size={24} />
                </div>

                <div>
                  <h2 className="text-2xl font-bold text-slate-900">
                    EduStream AI Assistant
                  </h2>

                  <p className="text-slate-500 text-sm">
                    Instant answers regarding admissions, fees, and courses.
                  </p>
                </div>
              </div>

              <div className="relative">
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  rows="4"
                  placeholder="Ask me anything, e.g. 'What are the admission requirements for 2026?'"
                  className="w-full p-4 pr-14 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all"
                />

                <button
                  onClick={askAI}
                  disabled={isLoading || !question.trim()}
                  className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white p-3 rounded-xl transition-all"
                >
                  {isLoading ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <Send size={20} />
                  )}
                </button>
              </div>

              {reply && (
                <div className="mt-6 bg-blue-50 border border-blue-100 rounded-2xl p-5">
                  <p className="font-bold text-blue-700 mb-2">AI Response</p>

                  <p className="text-slate-700 leading-relaxed">{reply}</p>
                </div>
              )}
            </div>

            {/* ---------------- Inquiry Form ---------------- */}

            <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
              <h2 className="text-2xl font-bold text-slate-900 mb-8">
                Send an Official Inquiry
              </h2>

              <form
                onSubmit={handleSubmit}
                className="grid grid-cols-1 md:grid-cols-2 gap-5"
              >
                {/* Full Name */}
                <div>
                  <label className="block mb-2 text-sm font-semibold text-slate-700">
                    Student Full Name
                  </label>

                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="Enter full name"
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="block mb-2 text-sm font-semibold text-slate-700">
                    Email Address
                  </label>

                  <input
                    type="email"
                    name="email"
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="Enter email address"
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                  />
                </div>

                {/* Department */}
                <div className="md:col-span-2">
                  <label className="block mb-2 text-sm font-semibold text-slate-700">
                    Select Department
                  </label>

                  <select
                    name="department"
                    value={formData.department}
                    onChange={handleChange}
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all"
                  >
                    <option value="">Choose Department</option>

                    <option value="Admissions">Admissions</option>

                    <option value="Academic Affairs">
                      Academic Affairs
                    </option>

                    <option value="Sports Department">
                      Sports Department
                    </option>

                    <option value="Career Counseling">
                      Career Counseling
                    </option>
                  </select>
                </div>

                {/* Message */}
                <div className="md:col-span-2">
                  <label className="block mb-2 text-sm font-semibold text-slate-700">
                    Your Message
                  </label>

                  <textarea
                    rows="5"
                    name="message"
                    value={formData.message}
                    onChange={handleChange}
                    placeholder="How can we help you?"
                    className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all resize-none"
                  />
                </div>

                {/* Error Message */}
                {error && (
                  <div className="md:col-span-2 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl">
                    <AlertCircle size={20} />
                    <p>{error}</p>
                  </div>
                )}

                {/* Success Message */}
                {success && (
                  <div className="md:col-span-2 flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 p-4 rounded-xl">
                    <CheckCircle2 size={20} />
                    <p>{success}</p>
                  </div>
                )}

                {/* Submit Button */}
                <button
                  type="submit"
                  disabled={formLoading}
                  className="md:col-span-2 bg-slate-950 hover:bg-slate-800 disabled:bg-slate-400 text-white py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
                >
                  {formLoading ? (
                    <>
                      <Loader2 className="animate-spin" size={20} />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Send size={18} />
                      Submit Inquiry
                    </>
                  )}
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