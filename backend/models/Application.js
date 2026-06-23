const mongoose = require("mongoose");

const applicationSchema = new mongoose.Schema(
  {
    studentName: {
      type: String,
      required: [true, "Student name is required"],
      trim: true,
      minlength: [2, "Student name must be at least 2 characters"],
      maxlength: [50, "Student name cannot exceed 50 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
      match: [
        /^\S+@\S+\.\S+$/,
        "Please enter a valid email address",
      ],
    },

    phone: {
      type: String,
      required: [true, "Phone number is required"],
      trim: true,
      match: [
        /^[0-9]{10}$/,
        "Please enter a valid 10-digit phone number",
      ],
    },

    dateOfBirth: {
      type: Date,
      required: [true, "Date of birth is required"],
    },

    grade: {
      type: String,
      required: [true, "Grade is required"],
      trim: true,
    },

    parentName: {
      type: String,
      required: [true, "Parent name is required"],
      trim: true,
      minlength: [2, "Parent name must be at least 2 characters"],
      maxlength: [50, "Parent name cannot exceed 50 characters"],
    },

    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
      minlength: [5, "Address must be at least 5 characters"],
      maxlength: [200, "Address cannot exceed 200 characters"],
    },

    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Application", applicationSchema);