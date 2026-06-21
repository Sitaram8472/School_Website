import React, { useState } from "react";
import faculty from "../data/faculty";
import TeacherCard from "../components/TeacherCard";

const FacultyDirectory = () => {
  const [selectedDepartment, setSelectedDepartment] = useState("All");

  const departments = [
    "All",
    "Science",
    "Mathematics",
    "English",
    "Computer Science",
  ];

  const filteredFaculty =
    selectedDepartment === "All"
      ? faculty
      : faculty.filter(
          (teacher) => teacher.department === selectedDepartment
        );

  return (
    <div style={{ padding: "40px" }}>
      <h1 style={{ textAlign: "center", marginBottom: "30px" }}>
        Faculty Directory
      </h1>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "10px",
          flexWrap: "wrap",
          marginBottom: "30px",
        }}
      >
        {departments.map((department) => (
          <button
            key={department}
            onClick={() => setSelectedDepartment(department)}
            style={{
              padding: "10px 20px",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              backgroundColor:
                selectedDepartment === department ? "#2563eb" : "#e5e7eb",
              color:
                selectedDepartment === department ? "white" : "black",
            }}
          >
            {department}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: "20px",
        }}
      >
        {filteredFaculty.map((teacher) => (
          <div
            key={teacher.id}
            style={{
              border: "1px solid #ddd",
              borderRadius: "12px",
              padding: "20px",
              textAlign: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
            }}
          >
            <img
              src={teacher.image}
              alt={teacher.name}
              style={{
                width: "120px",
                height: "120px",
                borderRadius: "50%",
                objectFit: "cover",
                marginBottom: "15px",
              }}
            />

            <h3>{teacher.name}</h3>

            <p>
              <strong>Department:</strong> {teacher.department}
            </p>

            <p>
              <strong>Subject:</strong> {teacher.subject}
            </p>

            <p>
              <strong>Email:</strong> {teacher.email}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default FacultyDirectory;