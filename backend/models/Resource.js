const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: 200,
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    fileName: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    teacherName: {
      type: String,
    },
    targetClass: {
      type: String,
      default: 'All Classes',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Resource', resourceSchema);
