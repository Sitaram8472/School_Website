const mongoose = require('mongoose');

const CATEGORIES = [
  'Fiction',
  'Non-Fiction',
  'Science',
  'Mathematics',
  'History',
  'Geography',
  'Literature',
  'Reference',
  'Competitive Exams',
  'Biography',
  'Technology',
  'Other',
];

/**
 * Accepts ISBN-10 and ISBN-13 with or without separators. Deliberately format
 * only — checksum validation would reject the many school books catalogued from
 * a slightly mistyped spine.
 */
const ISBN_PATTERN = /^(?:\d[\d-\s]{8,16}[\dXx])$/;

const bookSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [2, 'Title must be at least 2 characters'],
      maxlength: [250, 'Title cannot exceed 250 characters'],
    },

    author: {
      type: String,
      required: [true, 'Author is required'],
      trim: true,
      maxlength: [150, 'Author cannot exceed 150 characters'],
    },

    isbn: {
      type: String,
      trim: true,
      // `sparse` so the many books catalogued without an ISBN do not all
      // collide on a null value.
      unique: true,
      sparse: true,
      validate: {
        validator: (value) => !value || ISBN_PATTERN.test(value),
        message: 'ISBN must be a valid 10 or 13 digit number',
      },
    },

    category: {
      type: String,
      enum: {
        values: CATEGORIES,
        message: 'Invalid category',
      },
      default: 'Other',
    },

    publisher: {
      type: String,
      trim: true,
      maxlength: [150, 'Publisher cannot exceed 150 characters'],
      default: '',
    },

    publishedYear: {
      type: Number,
      min: [1400, 'Published year looks too early'],
      max: [new Date().getFullYear() + 1, 'Published year cannot be in the future'],
    },

    edition: {
      type: String,
      trim: true,
      maxlength: [50, 'Edition cannot exceed 50 characters'],
      default: '',
    },

    language: {
      type: String,
      trim: true,
      maxlength: [50, 'Language cannot exceed 50 characters'],
      default: 'English',
    },

    shelfLocation: {
      type: String,
      trim: true,
      maxlength: [50, 'Shelf location cannot exceed 50 characters'],
      default: '',
    },

    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: '',
    },

    coverUrl: {
      type: String,
      trim: true,
      default: '',
    },

    totalCopies: {
      type: Number,
      required: [true, 'Total copies is required'],
      min: [1, 'A catalogued book needs at least one copy'],
      max: [10000, 'Total copies is unreasonably high'],
    },

    availableCopies: {
      type: Number,
      default: 0,
      min: [0, 'Available copies cannot be negative'],
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'The librarian adding the book is required'],
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Free-text search over the two fields people actually search by.
bookSchema.index({ title: 'text', author: 'text' });
bookSchema.index({ category: 1, isActive: 1 });
bookSchema.index({ availableCopies: 1 });

bookSchema.virtual('isAvailable').get(function () {
  return this.isActive && this.availableCopies > 0;
});

bookSchema.virtual('issuedCopies').get(function () {
  return Math.max(0, this.totalCopies - this.availableCopies);
});

/**
 * A new book starts fully available. On later edits the invariant
 * `0 <= availableCopies <= totalCopies` is enforced rather than assumed.
 */
bookSchema.pre('validate', async function () {
  if (this.isNew && !this.availableCopies) {
    this.availableCopies = this.totalCopies;
  }

  if (this.availableCopies > this.totalCopies) {
    const error = new Error('Available copies cannot exceed total copies');
    error.userFacing = true;
    throw error;
  }
});

bookSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('Book', bookSchema);
