import { useState } from "react";
import { MessageSquare, CheckCircle2, AlertCircle, Loader2, Send } from "lucide-react";
import api from "../utils/axios";

const ContactFeedbackForm = () => {
  const [formData, setFormData] = useState({ name: "", email: "", subject: "", message: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState(null); // 'success' | 'error' | null
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = "Name is required.";
    if (!formData.email.trim()) {
      newErrors.email = "Email is required.";
    } else if (!/^\S+@\S+\.\S+$/.test(formData.email)) {
      newErrors.email = "Enter a valid email address.";
    }
    if (!formData.subject.trim()) newErrors.subject = "Subject is required.";
    if (!formData.message.trim()) newErrors.message = "Message is required.";
    return newErrors;
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
    setErrors({ ...errors, [e.target.name]: "" });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setLoading(true);
    setStatus(null);
    try {
      await api.post("/contact", formData);
      setStatus("success");
      setFormData({ name: "", email: "", subject: "", message: "" });
    } catch {
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-[var(--card-bg)] p-8 rounded-3xl border border-slate-200 shadow-sm">
      <div className="flex items-center gap-4 mb-6">
        <div className="bg-blue-600 text-white p-3 rounded-xl">
          <MessageSquare size={24} />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-[var(--text-primary)]">Send Us Feedback</h2>
          <p className="text-slate-500 text-sm">Share your thoughts, suggestions, or general queries.</p>
        </div>
      </div>

      {status === "success" && (
        <div className="mb-5 flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 p-4 rounded-xl">
          <CheckCircle2 size={20} />
          <p>Your message has been received. We will get back to you soon!</p>
        </div>
      )}
      {status === "error" && (
        <div className="mb-5 flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl">
          <AlertCircle size={20} />
          <p>Something went wrong. Please try again later.</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-5" noValidate>
        {/* Name */}
        <div>
          <label className="block mb-2 text-sm font-semibold text-slate-700">
            Full Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="Your full name"
            className={`w-full p-3 bg-[var(--bg-secondary)] border rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.name ? "border-red-400" : "border-slate-200"
            }`}
          />
          {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
        </div>

        {/* Email */}
        <div>
          <label className="block mb-2 text-sm font-semibold text-slate-700">
            Email Address <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="you@example.com"
            className={`w-full p-3 bg-[var(--bg-secondary)] border rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.email ? "border-red-400" : "border-slate-200"
            }`}
          />
          {errors.email && <p className="text-red-500 text-xs mt-1">{errors.email}</p>}
        </div>

        {/* Subject */}
        <div className="md:col-span-2">
          <label className="block mb-2 text-sm font-semibold text-slate-700">
            Subject <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            name="subject"
            value={formData.subject}
            onChange={handleChange}
            placeholder="What is this about?"
            className={`w-full p-3 bg-[var(--bg-secondary)] border rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all ${
              errors.subject ? "border-red-400" : "border-slate-200"
            }`}
          />
          {errors.subject && <p className="text-red-500 text-xs mt-1">{errors.subject}</p>}
        </div>

        {/* Message */}
        <div className="md:col-span-2">
          <label className="block mb-2 text-sm font-semibold text-slate-700">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            name="message"
            value={formData.message}
            onChange={handleChange}
            rows={5}
            placeholder="Write your message here..."
            className={`w-full p-3 bg-[var(--bg-secondary)] border rounded-xl outline-none focus:ring-2 focus:ring-blue-500 resize-none transition-all ${
              errors.message ? "border-red-400" : "border-slate-200"
            }`}
          />
          {errors.message && <p className="text-red-500 text-xs mt-1">{errors.message}</p>}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="md:col-span-2 bg-slate-950 hover:bg-slate-800 disabled:bg-slate-400 text-white py-4 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin" size={20} />
              Sending...
            </>
          ) : (
            <>
              <Send size={18} />
              Send Feedback
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default ContactFeedbackForm;
