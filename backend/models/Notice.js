const mongoose = require('mongoose');

const noticeSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters'],
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
      minlength: [2, 'Category must be at least 2 characters'],
      maxlength: [100, 'Category cannot exceed 100 characters'],
    },
    content: {
      type: String,
      required: [true, 'Content is required'],
      trim: true,
      minlength: [10, 'Content must be at least 10 characters'],
    },
    message: {
      type: String,
      trim: true,
      default: function () {
        return this.content || 'No details provided';
      },
    },
    targetClass: {
      type: String,
      trim: true,
      default: 'All',
      maxlength: [50, 'Target class cannot exceed 50 characters'],
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Posted by is required'],
    },
    teacherName: {
      type: String,
      trim: true,
      maxlength: [100, 'Teacher name cannot exceed 100 characters'],
    },
    status: {
      type: String,
      enum: {
        values: ['draft', 'scheduled', 'published', 'archived'],
        message: 'Invalid status',
      },
      default: 'draft',
    },
    publishAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    date: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Indexes for frequently queried fields
noticeSchema.index({ category: 1 });
noticeSchema.index({ targetClass: 1 });
noticeSchema.index({ date: -1 });
noticeSchema.index({ status: 1, publishAt: 1 });
noticeSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('Notice', noticeSchema);