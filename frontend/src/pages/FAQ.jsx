import React, { useState } from "react";

const faqData = [
  {
    question: "How does the school decide student class placement after admission?",
    answer:
      "Students are placed based on previous academic records, entrance assessment (if applicable), and age criteria to ensure balanced learning environments.",
  },
  {
    question: "What makes this school different from other nearby schools?",
    answer:
      "We focus on a hybrid learning model combining academic excellence, digital tools, personality development, and real-world skill exposure through projects and events, ensuring all students receive a holistic education.",
  },
  {
    question: "Can parents track student academic progress online?",
    answer:
      "Yes, parents can access student performance reports, attendance, and feedback through the student dashboard portal.",
  },
  {
    question: "Are students allowed to participate in tech or innovation clubs?",
    answer:
      "Yes, we strongly encourage participation in coding clubs, robotics, science exhibitions, debate teams, and creative arts programs.",
  },
  {
    question: "How are teachers selected and evaluated?",
    answer:
      "Teachers are selected through a comprehensive multi-stage process including subject expertise evaluation, demo classes, and continuous performance feedback reviews.",
  },
  {
    question: "Does the school provide career guidance for higher studies?",
    answer:
      "Yes, we provide dedicated counseling sessions, career workshops, and guidance for competitive exams and university admissions.",
  },
  {
    question: "What safety measures are implemented on campus?",
    answer:
      "The campus employs CCTV surveillance, verified staff access, emergency protocols, and regular safety drills for students.",
  },
  {
    question: "How does the school handle student doubts outside classroom hours?",
    answer:
      "Students can utilize after-school doubt sessions, digital forums, and teacher office hours for academic support.",
  },
];

const FAQ = () => {
  const [openIndex, setOpenIndex] = useState(null);

  const toggleFAQ = (index) => {
    setOpenIndex(openIndex === index ? null : index);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-center mb-8">
        Frequently Asked Questions
      </h1>

      <div className="space-y-4">
        {faqData.map((item, index) => (
          <div
            key={index}
            className="border rounded-lg shadow-md hover:shadow-lg transition-shadow overflow-hidden"
          >
            <button
              onClick={() => toggleFAQ(index)}
              aria-expanded={openIndex === index}
              aria-controls={`faq-${index}`}
              className="w-full text-left px-4 py-3 bg-blue-600 hover:bg-blue-700 transition-colors text-white font-medium flex justify-between items-center"
            >
              {item.question}
              <span
                className={`text-xl transition-transform duration-300 ${
                  openIndex === index ? "rotate-180" : ""
                }`}
              >
                +
              </span>
            </button>

            <div
              id={`faq-${index}`}
              className={`overflow-hidden transition-all duration-300 ease-in-out ${
                openIndex === index ? "max-h-40 p-4" : "max-h-0"
              } bg-white text-gray-700`}
            >
              <p>{item.answer}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default FAQ;
