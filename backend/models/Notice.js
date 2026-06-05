const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
    },
    targetClass: {
      type: String,
      default: 'All',
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    teacherName: {
      type: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notice', noticeSchema);
