// import mongoose from "mongoose";
const mongoose = require("mongoose");
const inquirySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
      minlength: [3, "Name must be at least 3 characters"],
      maxlength: [50, "Name cannot exceed 50 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,

      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please enter a valid email address",
      ],
    },

    department: {
      type: String,
      required: [true, "Department is required"],

      enum: {
        values: [
          "Admissions",
          "Academic Affairs",
          "Sports Department",
          "Career Counseling",
        ],

        message: "Invalid department selected",
      },
    },

    message: {
      type: String,
      required: [true, "Message is required"],
      trim: true,
      minlength: [10, "Message must be at least 10 characters"],
      maxlength: [1000, "Message cannot exceed 1000 characters"],
    },
  },

  {
    timestamps: true,
  },
);

const Inquiry = mongoose.model("Inquiry", inquirySchema);

module.exports = Inquiry;