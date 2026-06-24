import React, { useRef } from "react";
import html2canvas from "html2canvas";
import { Download } from "lucide-react";

const StudentIDCard = () => {
  const cardRef = useRef(null);

  const student = {
    name: "Rahul Sharma",
    rollNo: "2026001",
    class: "10",
    section: "A",
    school: "EduStream Academy",
    photo: "https://via.placeholder.com/120",
  };

  const downloadCard = async () => {
    try {
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });

      const image = canvas.toDataURL("image/png");

      const link = document.createElement("a");
      link.href = image;
      link.download = `${student.name}-ID-Card.png`;
      link.click();
    } catch (error) {
      console.error("Download Error:", error);
      alert("Failed to download ID card");
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center py-10 px-4"
      style={{ backgroundColor: "#f3f4f6" }}
    >
      <h1
        className="text-4xl font-bold mb-8"
        style={{ color: "#2563eb" }}
      >
        Student ID Card Generator
      </h1>

      <div
        ref={cardRef}
        id="id-card"
        style={{
          width: "380px",
          backgroundColor: "#ffffff",
          border: "2px solid #2563eb",
          borderRadius: "16px",
          overflow: "hidden",
          boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
        }}
      >
        {/* Header */}
        <div
          style={{
            backgroundColor: "#2563eb",
            color: "#ffffff",
            textAlign: "center",
            padding: "16px",
          }}
        >
          <h2
            style={{
              fontSize: "28px",
              fontWeight: "bold",
              margin: 0,
            }}
          >
            {student.school}
          </h2>

          <p
            style={{
              marginTop: "6px",
              fontSize: "14px",
            }}
          >
            Official Student Identity Card
          </p>
        </div>

        {/* Body */}
        <div
          style={{
            display: "flex",
            gap: "20px",
            padding: "24px",
            alignItems: "center",
          }}
        >
          <img
            src={student.photo}
            alt="Student"
            style={{
              width: "110px",
              height: "110px",
              borderRadius: "8px",
              border: "1px solid #ccc",
              objectFit: "cover",
            }}
          />

          <div>
            <p>
              <strong>Name:</strong> {student.name}
            </p>

            <p>
              <strong>Roll No:</strong> {student.rollNo}
            </p>

            <p>
              <strong>Class:</strong> {student.class}
            </p>

            <p>
              <strong>Section:</strong> {student.section}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            backgroundColor: "#f3f4f6",
            textAlign: "center",
            padding: "12px",
            color: "#4b5563",
          }}
        >
          EduStream Academy • Student ID
        </div>
      </div>

      <button
        onClick={downloadCard}
        className="mt-8 flex items-center gap-2 px-6 py-3 rounded-xl text-white"
        style={{ backgroundColor: "#2563eb" }}
      >
        <Download size={18} />
        Download ID Card
      </button>
    </div>
  );
};

export default StudentIDCard;