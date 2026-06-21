const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    subject: {
      type: String,
      required: [true, 'Subject is required'],
      trim: true,
      maxlength: 200,
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Contact', contactSchema);
