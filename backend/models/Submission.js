const mongoose = require("mongoose");

const submissionSchema = new mongoose.Schema(
  {
    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Exam",
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    answers: [
      {
        questionId: { type: mongoose.Schema.Types.ObjectId, required: true },
        providedAnswer: { type: String },
      },
    ],
    score: {
      type: Number,
      default: 0,
    },
    cheatWarnings: {
      type: Number,
      default: 0,
    },
    isAutoSubmitted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

submissionSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("Submission", submissionSchema);
