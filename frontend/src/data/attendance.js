const attendanceData = {
  totalClasses: 100,
  presentClasses: 92,

  monthlyReport: {
    month: "June 2026",
    totalClasses: 20,
    presentClasses: 18,
    absentClasses: 2,
  },

  subjectAttendance: [
    {
      subject: "Mathematics",
      attendance: 95,
    },
    {
      subject: "Science",
      attendance: 88,
    },
    {
      subject: "English",
      attendance: 82,
    },
    {
      subject: "Computer",
      attendance: 98,
    },
    {
      subject: "History",
      attendance: 68,
    },
  ],

  monthlyTrend: [
    { month: "Jan", attendance: 82 },
    { month: "Feb", attendance: 86 },
    { month: "Mar", attendance: 90 },
    { month: "Apr", attendance: 84 },
    { month: "May", attendance: 92 },
    { month: "Jun", attendance: 90 },
  ],
};

export default attendanceData;