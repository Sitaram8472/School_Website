import React, { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BookOpen, Search, AlertTriangle, RefreshCw, Library as LibraryIcon } from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import BookFormModal from '../components/library/BookFormModal';

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

const LOAN_STATUS_STYLES = {
  issued: 'bg-blue-100 text-blue-700',
  returned: 'bg-green-100 text-green-700',
  overdue: 'bg-red-100 text-red-700',
  lost: 'bg-gray-200 text-gray-600',
};

const Library = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isLibrarian = ['admin', 'staff', 'teacher'].includes(role);

  const [tab, setTab] = useState('catalogue');

  const [books, setBooks] = useState([]);
  const [categories, setCategories] = useState(['All']);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ pages: 1, total: 0 });

  const [myLoans, setMyLoans] = useState([]);
  const [loanSummary, setLoanSummary] = useState({
    activeLoans: 0,
    overdueLoans: 0,
    outstandingFines: 0,
    borrowLimit: 3,
  });

  const [overdue, setOverdue] = useState({ rows: [], summary: null });

  const [modalOpen, setModalOpen] = useState(false);
  const [editingBook, setEditingBook] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 3000);
  };

  const fetchBooks = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page, limit: 12 };
      if (search.trim()) params.search = search.trim();
      if (category !== 'All') params.category = category;
      if (availableOnly) params.availableOnly = 'true';

      const res = await api.get('/library/books', { params });
      setBooks(res.data.data || []);
      setPagination(res.data.pagination || { pages: 1, total: 0 });
      if (res.data.categories) setCategories(['All', ...res.data.categories]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the catalogue right now.');
    } finally {
      setLoading(false);
    }
  }, [page, search, category, availableOnly]);

  const fetchMyLoans = useCallback(async () => {
    try {
      const res = await api.get('/library/loans/me');
      setMyLoans(res.data.data || []);
      setLoanSummary(res.data.summary || loanSummary);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your borrowing history.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchOverdue = useCallback(async () => {
    try {
      const res = await api.get('/library/overdue');
      setOverdue({ rows: res.data.data || [], summary: res.data.summary || null });
    } catch {
      setOverdue({ rows: [], summary: null });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(fetchBooks, 300);
    return () => clearTimeout(timer);
  }, [fetchBooks]);

  useEffect(() => {
    fetchMyLoans();
    if (isLibrarian) fetchOverdue();
  }, [fetchMyLoans, fetchOverdue, isLibrarian]);

  // Reset to the first page whenever a filter narrows the result set.
  useEffect(() => {
    setPage(1);
  }, [search, category, availableOnly]);

  const activeLoans = useMemo(
    () => myLoans.filter((loan) => loan.status === 'issued' || loan.status === 'overdue'),
    [myLoans]
  );

  const handleSaveBook = async (payload) => {
    try {
      if (editingBook?._id) {
        await api.put(`/library/books/${editingBook._id}`, payload);
        flash('Book updated.');
      } else {
        await api.post('/library/books', payload);
        flash('Book added to the catalogue.');
      }
      setModalOpen(false);
      setEditingBook(null);
      fetchBooks();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save the book.');
    }
  };

  const handleDeleteBook = async (book) => {
    if (!window.confirm(`Remove "${book.title}" from the catalogue?`)) return;
    try {
      await api.delete(`/library/books/${book._id}`);
      flash('Book removed.');
      fetchBooks();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove the book.');
    }
  };

  const handleRenew = async (loan) => {
    try {
      const res = await api.patch(`/library/loans/${loan._id}/renew`);
      flash(res.data.message);
      fetchMyLoans();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to renew this loan.');
    }
  };

  return (
    <div
      className="min-h-screen p-4 sm:p-6"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-amber-700 to-orange-700 text-white rounded-3xl p-8 shadow-2xl mb-8">
        <Link
          to={isLibrarian ? '/teacher/dashboard' : '/student'}
          className="inline-flex items-center gap-2 text-amber-100 hover:text-white text-sm"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="flex items-center gap-4 mt-4">
          <div className="bg-white text-amber-700 p-4 rounded-full shadow-lg">
            <LibraryIcon size={30} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-4xl font-bold">School Library</h1>
            <p className="text-amber-100 mt-1">
              Search the catalogue, check availability and track what you have borrowed.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {[
            { label: 'Books catalogued', value: pagination.total },
            { label: 'Your active loans', value: `${loanSummary.activeLoans}/${loanSummary.borrowLimit}` },
            { label: 'Your overdue books', value: loanSummary.overdueLoans },
            { label: 'Fines owed', value: `₹${loanSummary.outstandingFines}` },
          ].map((tile) => (
            <div key={tile.label} className="bg-white/15 rounded-2xl p-4">
              <div className="text-xl font-bold">{tile.value}</div>
              <div className="text-xs text-amber-100 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-2xl shadow p-1 flex gap-2 mb-6">
        {[
          { id: 'catalogue', label: 'Catalogue' },
          { id: 'my-books', label: `My books (${activeLoans.length})` },
          ...(isLibrarian ? [{ id: 'overdue', label: `Overdue (${overdue.rows.length})` }] : []),
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`flex-1 py-2.5 px-4 rounded-xl text-sm font-medium transition ${
              tab === item.id ? 'bg-amber-600 text-white shadow' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4 mb-6">{error}</div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-100 text-green-700 rounded-2xl p-4 mb-6">
          {success}
        </div>
      )}

      {/* Catalogue */}
      {tab === 'catalogue' && (
        <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
          <div className="flex flex-col md:flex-row gap-4 mb-6">
            <div className="relative flex-1">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search by title, author or ISBN..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border rounded-xl pl-11 pr-4 py-3 text-gray-700"
              />
            </div>

            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="border rounded-xl px-4 py-3 text-gray-700"
            >
              {categories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-sm text-gray-600 whitespace-nowrap">
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(e) => setAvailableOnly(e.target.checked)}
              />
              Available only
            </label>

            {isLibrarian && (
              <button
                onClick={() => {
                  setEditingBook(null);
                  setModalOpen(true);
                }}
                className="bg-amber-600 hover:bg-amber-700 text-white px-6 py-3 rounded-xl font-semibold transition whitespace-nowrap"
              >
                + Add book
              </button>
            )}
          </div>

          {loading ? (
            <p className="text-gray-500 text-center py-12">Loading the catalogue...</p>
          ) : books.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <BookOpen size={40} className="mx-auto text-gray-300" />
              <p className="text-lg font-semibold mt-4">No books match your search</p>
              <p className="text-sm mt-2">Try a different title, author or category.</p>
            </div>
          ) : (
            <>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {books.map((book) => (
                  <div
                    key={book._id}
                    className="border rounded-2xl p-5 hover:shadow-xl transition flex flex-col"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-bold text-gray-800 leading-snug">{book.title}</h3>
                      <span
                        className={`text-[11px] px-2 py-1 rounded-full whitespace-nowrap ${
                          book.availableCopies > 0
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {book.availableCopies > 0 ? `${book.availableCopies} available` : 'All out'}
                      </span>
                    </div>

                    <p className="text-sm text-gray-500 mt-1">by {book.author}</p>

                    <div className="flex flex-wrap gap-2 mt-3">
                      <span className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {book.category}
                      </span>
                      {book.shelfLocation && (
                        <span className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                          📍 {book.shelfLocation}
                        </span>
                      )}
                      {book.publishedYear && (
                        <span className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                          {book.publishedYear}
                        </span>
                      )}
                    </div>

                    {book.description && (
                      <p className="text-xs text-gray-500 mt-3 line-clamp-3">{book.description}</p>
                    )}

                    <p className="text-xs text-gray-400 mt-3">
                      {book.totalCopies - book.availableCopies} of {book.totalCopies} on loan
                    </p>

                    {isLibrarian && (
                      <div className="flex gap-3 mt-4 pt-3 border-t border-gray-100">
                        <button
                          onClick={() => {
                            setEditingBook(book);
                            setModalOpen(true);
                          }}
                          className="text-blue-600 hover:text-blue-800 text-xs font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteBook(book)}
                          className="text-red-400 hover:text-red-600 text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {pagination.pages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-8">
                  <button
                    onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    disabled={page === 1}
                    className="px-4 py-2 rounded-lg border text-sm disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-500">
                    Page {page} of {pagination.pages}
                  </span>
                  <button
                    onClick={() => setPage((prev) => Math.min(pagination.pages, prev + 1))}
                    disabled={page >= pagination.pages}
                    className="px-4 py-2 rounded-lg border text-sm disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* My books */}
      {tab === 'my-books' && (
        <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">My borrowing history</h2>

          {myLoans.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <BookOpen size={40} className="mx-auto text-gray-300" />
              <p className="text-lg font-semibold mt-4">You have not borrowed anything yet</p>
              <p className="text-sm mt-2">Find a book in the catalogue and ask the librarian to issue it.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {myLoans.map((loan) => (
                <div key={loan._id} className="border rounded-2xl p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-gray-800">{loan.book?.title || loan.bookTitle}</p>
                      <p className="text-sm text-gray-500 mt-1">{loan.book?.author}</p>

                      <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500">
                        <span>Issued {formatDate(loan.issuedAt)}</span>
                        <span>Due {formatDate(loan.dueDate)}</span>
                        {loan.returnedAt && <span>Returned {formatDate(loan.returnedAt)}</span>}
                        {loan.renewalCount > 0 && <span>Renewed {loan.renewalCount}×</span>}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span
                        className={`text-xs px-3 py-1 rounded-full ${
                          LOAN_STATUS_STYLES[loan.overdue ? 'overdue' : loan.status] ||
                          LOAN_STATUS_STYLES.issued
                        }`}
                      >
                        {loan.overdue ? `${loan.daysOverdue} days overdue` : loan.status}
                      </span>

                      {loan.estimatedFine > 0 && (
                        <p className="text-xs text-red-600 mt-2">Fine ₹{loan.estimatedFine}</p>
                      )}

                      {loan.status === 'issued' && !loan.overdue && loan.renewalCount < 2 && (
                        <button
                          onClick={() => handleRenew(loan)}
                          className="mt-2 inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-medium"
                        >
                          <RefreshCw size={12} /> Renew
                        </button>
                      )}
                    </div>
                  </div>

                  {loan.overdue && (
                    <p className="mt-3 flex items-center gap-2 text-xs text-red-600">
                      <AlertTriangle size={14} />
                      Please return this book to the library as soon as possible.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Overdue report */}
      {tab === 'overdue' && isLibrarian && (
        <div className="bg-white rounded-3xl shadow-xl p-6 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
            <h2 className="text-2xl font-bold text-gray-800">Overdue report</h2>
            {overdue.summary && (
              <p className="text-sm text-gray-500">
                {overdue.summary.overdueCount} overdue · ₹{overdue.summary.totalFines} in fines at ₹
                {overdue.summary.finePerDay}/day
              </p>
            )}
          </div>

          {overdue.rows.length === 0 ? (
            <p className="text-gray-500 text-center py-12">Nothing is overdue. The shelves are happy.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[600px]">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Book</th>
                    <th className="text-left px-4 py-3 font-medium">Borrower</th>
                    <th className="text-left px-4 py-3 font-medium">Due</th>
                    <th className="text-right px-4 py-3 font-medium">Days late</th>
                    <th className="text-right px-4 py-3 font-medium">Fine</th>
                  </tr>
                </thead>
                <tbody>
                  {overdue.rows.map((row) => (
                    <tr key={row._id} className="border-t border-gray-100">
                      <td className="px-4 py-3 text-gray-700">{row.bookTitle}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {row.studentName}
                        {row.studentEmail && (
                          <span className="block text-xs text-gray-400">{row.studentEmail}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500">{formatDate(row.dueDate)}</td>
                      <td className="px-4 py-3 text-right text-red-600 font-medium">{row.daysOverdue}</td>
                      <td className="px-4 py-3 text-right text-gray-700">₹{row.fine}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <BookFormModal
        open={modalOpen}
        book={editingBook}
        onClose={() => {
          setModalOpen(false);
          setEditingBook(null);
        }}
        onSave={handleSaveBook}
      />
    </div>
  );
};

export default Library;
