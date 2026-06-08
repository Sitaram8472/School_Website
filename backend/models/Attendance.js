const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
    className: {
      type: String,
      required: [true, 'Class name is required'],
      trim: true,
    },
    date: {
      type: String,
      required: [true, 'Date is required'],
    },
    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    teacherName: {
      type: String,
    },
    records: [
      {
        studentName: { type: String, required: true },
        status: {
          type: String,
          enum: ['Present', 'Absent'],
          default: 'Present',
        },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Attendance', attendanceSchema);
