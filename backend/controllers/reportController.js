const User = require("../models/User");
const Course = require("../models/Course");
const Submission = require("../models/Submission");
const Attendance = require("../models/Attendance");
const PDFDocument = require("pdfkit");
const mongoose = require("mongoose");
const { memoryCache } = require("../utils/cache");

exports.generateReportCard = async (req, res) => {
  try {
    const studentId = req.params.id;

    // Validate access
    if (req.user.role === "student" && req.user.id !== studentId) {
      return res.status(403).json({ success: false, message: "Unauthorized to view this report card." });
    }

    // Check cache first
    const cacheKey = `report_${studentId}`;
    let cachedData = memoryCache.get(cacheKey);
    let student, courses, submissions, attendances, totalClasses, presentClasses, attendancePercentage;

    if (cachedData) {
      ({ student, courses, submissions, attendances, totalClasses, presentClasses, attendancePercentage } = cachedData);
    } else {
      // Fetch Student Info
      student = await User.findById(studentId);
      if (!student || student.role !== "student") {
        return res.status(404).json({ success: false, message: "Student not found." });
      }

      // Fetch Courses
      courses = await Course.find({ students: studentId });

      // Fetch Submissions/Exams
      submissions = await Submission.find({ student: studentId }).populate({
        path: "exam",
        populate: { path: "course", select: "name" },
      });

      // Fetch Attendance
      attendances = await Attendance.find({ "records.studentName": student.name });
      totalClasses = 0;
      presentClasses = 0;

      attendances.forEach((attendance) => {
        const record = attendance.records.find((r) => r.studentName === student.name);
        if (record) {
          totalClasses++;
          if (record.status === "Present") {
            presentClasses++;
          }
        }
      });

      attendancePercentage = totalClasses > 0 ? ((presentClasses / totalClasses) * 100).toFixed(2) : "0.00";

      // Cache for 5 minutes (300 seconds)
      memoryCache.set(cacheKey, {
        student, courses, submissions, attendances, totalClasses, presentClasses, attendancePercentage
      }, 300);
    }

    // Setup PDF
    const doc = new PDFDocument({ margin: 50 });
    const filename = `Report_Card_${student.name.replace(/\s+/g, "_")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    doc.pipe(res);

    // Header Background
    doc.rect(0, 0, 612, 120).fill("#1d4ed8"); // Blue header

    // School Name & Tagline
    doc.fillColor("#ffffff").fontSize(24).font("Helvetica-Bold").text("EduStream Academy", 50, 40, { align: "center" });
    doc.fontSize(12).font("Helvetica").text("Empowering Minds, Shaping Futures", 50, 70, { align: "center" });
    doc.fontSize(16).font("Helvetica-Bold").text("Official Report Card", 50, 95, { align: "center" });

    // Reset fill color for body
    doc.fillColor("#000000");
    doc.moveDown(4); // Move past header

    // Student Information Section
    doc.fontSize(14).font("Helvetica-Bold").text("Student Information", 50, 150);
    doc.moveTo(50, 165).lineTo(562, 165).stroke("#e5e7eb"); // Divider
    
    doc.fontSize(11).font("Helvetica").text(`Name: ${student.name}`, 50, 180);
    doc.text(`Email: ${student.email}`, 50, 200);
    doc.text(`Student ID: ${student._id}`, 300, 180);
    doc.text(`Date Issued: ${new Date().toLocaleDateString()}`, 300, 200);

    doc.moveDown(2);

    // Attendance Summary
    doc.fontSize(14).font("Helvetica-Bold").text("Attendance Summary", 50, doc.y);
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).stroke("#e5e7eb"); // Divider
    doc.moveDown(1);
    
    doc.fontSize(11).font("Helvetica");
    doc.text(`Total Classes: ${totalClasses}`, 50, doc.y);
    doc.text(`Present: ${presentClasses}`, 200, doc.y - 14); // keep same line
    doc.text(`Absent: ${totalClasses - presentClasses}`, 350, doc.y - 14);
    
    // Attendance Bar
    doc.moveDown(1);
    doc.text(`Attendance Rate: ${attendancePercentage}%`, 50, doc.y);
    const barWidth = 400;
    const filledWidth = (attendancePercentage / 100) * barWidth;
    doc.rect(50, doc.y + 5, barWidth, 10).fillAndStroke("#e5e7eb", "#e5e7eb"); // bg bar
    doc.rect(50, doc.y + 5, filledWidth || 0, 10).fillAndStroke(attendancePercentage >= 75 ? "#16a34a" : "#dc2626", attendancePercentage >= 75 ? "#16a34a" : "#dc2626"); // filled bar
    doc.fillColor("#000000"); // reset
    
    doc.moveDown(3);

    // Academic Performance (Grades Table)
    doc.fontSize(14).font("Helvetica-Bold").text("Academic Performance", 50, doc.y);
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).stroke("#e5e7eb"); // Divider
    doc.moveDown(1);

    // Table Header
    const tableTop = doc.y;
    doc.font("Helvetica-Bold").fontSize(10);
    doc.rect(50, tableTop, 512, 25).fill("#f3f4f6");
    doc.fillColor("#000000");
    doc.text("Course", 55, tableTop + 8);
    doc.text("Exam", 180, tableTop + 8);
    doc.text("Score", 320, tableTop + 8);
    doc.text("Max", 370, tableTop + 8);
    doc.text("%", 420, tableTop + 8);
    doc.text("Grade", 470, tableTop + 8);
    
    doc.moveTo(50, tableTop + 25).lineTo(562, tableTop + 25).stroke("#d1d5db");

    let currentY = tableTop + 25;
    doc.font("Helvetica").fontSize(10);

    const getGrade = (percentage) => {
      if (percentage >= 90) return "A+";
      if (percentage >= 80) return "A";
      if (percentage >= 70) return "B+";
      if (percentage >= 60) return "B";
      if (percentage >= 50) return "C";
      return "F";
    };

    if (submissions.length === 0) {
        doc.text("No exam records found.", 55, currentY + 10);
        currentY += 30;
    } else {
        submissions.forEach((sub, i) => {
            // New page check
            if (currentY > 700) {
                doc.addPage();
                currentY = 50;
            }

            // Alternating row background
            if (i % 2 === 0) {
                doc.rect(50, currentY, 512, 25).fill("#f9fafb");
                doc.fillColor("#000000");
            }

            const courseName = sub.exam?.course?.name || "General";
            const examTitle = sub.exam?.title || "Unknown";
            const score = sub.score;
            
            // Calculate max score (sum of points for all questions in the exam)
            let maxScore = 0;
            if (sub.exam && sub.exam.questions) {
                sub.exam.questions.forEach(q => maxScore += (q.points || 1));
            } else {
               // Fallback if exam questions are not fully populated or missing
               maxScore = score > 0 ? score : 1; 
            }
            // Prevent division by zero
            if(maxScore === 0) maxScore = 1;

            const percentage = ((score / maxScore) * 100).toFixed(1);
            const grade = getGrade(percentage);

            doc.text(courseName.substring(0, 20), 55, currentY + 8);
            doc.text(examTitle.substring(0, 20), 180, currentY + 8);
            doc.text(score.toString(), 320, currentY + 8);
            doc.text(maxScore.toString(), 370, currentY + 8);
            doc.text(`${percentage}%`, 420, currentY + 8);
            doc.font("Helvetica-Bold").text(grade, 470, currentY + 8).font("Helvetica");

            doc.moveTo(50, currentY + 25).lineTo(562, currentY + 25).stroke("#e5e7eb");
            currentY += 25;
        });
    }

    doc.moveDown(2);
    doc.y = currentY + 20; // Ensure y is correct after table

    // Enrolled Courses List
    doc.fontSize(14).font("Helvetica-Bold").text("Enrolled Courses", 50, doc.y);
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).stroke("#e5e7eb"); // Divider
    doc.moveDown(1);
    
    doc.fontSize(10).font("Helvetica");
    if (courses.length === 0) {
      doc.text("Not enrolled in any courses.");
    } else {
      const courseList = courses.map(c => c.name).join(", ");
      doc.text(courseList, { width: 512 });
    }

    // Footer
    const pageHeight = doc.page.height;
    doc.fontSize(8).fillColor("gray");
    doc.text("This is a computer-generated document. No signature is required.", 50, pageHeight - 70, { align: "center" });
    doc.text(`Generated on ${new Date().toLocaleString()}`, 50, pageHeight - 55, { align: "center" });

    doc.end();

  } catch (error) {
    console.error("Error generating report card:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Error generating report card", error: error.message });
    }
  }
};
