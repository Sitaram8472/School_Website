import { useState, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';

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

const EMPTY_BOOK = {
  title: '',
  author: '',
  isbn: '',
  category: 'Other',
  publisher: '',
  publishedYear: '',
  edition: '',
  language: 'English',
  shelfLocation: '',
  description: '',
  coverUrl: '',
  totalCopies: 1,
};

// Format only — the same rule the Book model applies, mirrored here so a typo
// is caught before a round trip.
const ISBN_PATTERN = /^(?:\d[\d-\s]{8,16}[\dXx])$/;

/**
 * Add / edit dialog for a catalogue entry. Closes on Escape and on a click
 * outside the panel.
 */
const BookFormModal = ({ open, book, onClose, onSave }) => {
  const [form, setForm] = useState(EMPTY_BOOK);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const isEditing = Boolean(book?._id);

  useEffect(() => {
    if (!open) return;

    setErrors({});
    setForm(
      book
        ? {
            title: book.title || '',
            author: book.author || '',
            isbn: book.isbn || '',
            category: book.category || 'Other',
            publisher: book.publisher || '',
            publishedYear: book.publishedYear || '',
            edition: book.edition || '',
            language: book.language || 'English',
            shelfLocation: book.shelfLocation || '',
            description: book.description || '',
            coverUrl: book.coverUrl || '',
            totalCopies: book.totalCopies ?? 1,
          }
        : EMPTY_BOOK
    );
  }, [open, book]);

  const handleEscape = useCallback(
    (event) => {
      if (event.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, handleEscape]);

  if (!open) return null;

  const validate = () => {
    const found = {};
    const currentYear = new Date().getFullYear();

    if (!form.title.trim()) found.title = 'Title is required.';
    if (!form.author.trim()) found.author = 'Author is required.';

    if (form.isbn.trim() && !ISBN_PATTERN.test(form.isbn.trim())) {
      found.isbn = 'Enter a valid 10 or 13 digit ISBN, or leave it blank.';
    }

    const copies = Number(form.totalCopies);
    if (!copies || copies < 1) {
      found.totalCopies = 'A catalogued book needs at least one copy.';
    } else if (isEditing && copies < book.totalCopies - book.availableCopies) {
      found.totalCopies = `${book.totalCopies - book.availableCopies} copies are on loan.`;
    }

    if (form.publishedYear) {
      const year = Number(form.publishedYear);
      if (Number.isNaN(year) || year < 1400 || year > currentYear + 1) {
        found.publishedYear = `Enter a year between 1400 and ${currentYear + 1}.`;
      }
    }

    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const payload = {
        ...form,
        totalCopies: Number(form.totalCopies),
        publishedYear: form.publishedYear ? Number(form.publishedYear) : undefined,
        isbn: form.isbn.trim() || undefined,
      };
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const field = (name, label, extra = {}) => (
    <label className="text-xs text-gray-500 block">
      {label}
      <input
        type={extra.type || 'text'}
        value={form[name]}
        min={extra.min}
        placeholder={extra.placeholder || ''}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        className={`mt-1 w-full border rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
          errors[name] ? 'border-red-400' : 'border-gray-300'
        }`}
      />
      {errors[name] && <span className="text-red-500 text-[11px] mt-1 block">{errors[name]}</span>}
    </label>
  );

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isEditing ? 'Edit book' : 'Add book'}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-3xl">
          <h3 className="text-lg font-bold text-gray-800">
            {isEditing ? 'Edit book' : 'Add a book to the catalogue'}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 transition"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            {field('title', 'Title *')}
            {field('author', 'Author *')}
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {field('isbn', 'ISBN', { placeholder: '978-0-13-235088-4' })}

            <label className="text-xs text-gray-500 block">
              Category
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700"
              >
                {CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>

            {field('totalCopies', 'Total copies *', { type: 'number', min: 1 })}
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {field('publisher', 'Publisher')}
            {field('publishedYear', 'Published year', { type: 'number' })}
            {field('edition', 'Edition')}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {field('language', 'Language')}
            {field('shelfLocation', 'Shelf location', { placeholder: 'Rack B / Shelf 3' })}
          </div>

          {field('coverUrl', 'Cover image URL')}

          <label className="text-xs text-gray-500 block">
            Description
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 resize-none"
            />
          </label>

          {isEditing && (
            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
              {book.totalCopies - book.availableCopies} of {book.totalCopies} copies are currently on
              loan.
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50"
            >
              {saving ? 'Saving...' : isEditing ? 'Save changes' : 'Add book'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 px-4 py-2.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default BookFormModal;
