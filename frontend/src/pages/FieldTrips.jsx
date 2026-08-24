import { useState, useEffect, useContext, useCallback } from 'react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';
import { getUserRole } from '../utils/permissions';
import RiskAssessmentPanel from '../components/trips/RiskAssessmentPanel';

/**
 * Field trips and excursions.
 *
 * The consent statement is rendered in full above the button rather than behind
 * a link, and the guardian types their name to sign it. That is not decoration:
 * the server stores the statement version alongside the typed name, and a
 * signature against something the signer never saw is worth nothing.
 *
 * Seat counts always come from the server on refresh rather than being adjusted
 * locally after a registration. The seat you think is free and the seat the
 * database thinks is free are allowed to disagree, and the database wins.
 */

const PURPOSE_LABELS = {
  academic: 'Academic',
  cultural: 'Cultural',
  sports: 'Sports',
  'community-service': 'Community service',
  recreational: 'Recreational',
};

const TRIP_STATUS_STYLES = {
  draft: 'bg-gray-200 text-gray-600',
  open: 'bg-green-100 text-green-700',
  closed: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-red-100 text-red-700',
  completed: 'bg-blue-100 text-blue-700',
};

const PARTICIPANT_STATUS_LABELS = {
  confirmed: 'Confirmed',
  withdrawn: 'Withdrawn',
  attended: 'Attended',
  absent: 'Did not travel',
};

const PAYMENT_LABELS = {
  'not-required': 'Free',
  pending: 'Payment due',
  paid: 'Paid',
  waived: 'Waived',
  refunded: 'Refunded',
};

const CONSENT_STATEMENT = [
  'I give permission for the child named above to take part in this trip, travelling by the stated transport and supervised by the named school staff.',
  'I confirm the medical and dietary information given here is accurate and complete, and I will tell the school if it changes before departure.',
  'I understand the school will contact me on the number given if anything happens during the trip.',
];

const emptyTripForm = {
  title: '',
  destination: '',
  purpose: 'academic',
  description: '',
  departureDate: '',
  returnDate: '',
  departureTime: '',
  returnTime: '',
  meetingPoint: '',
  transportMode: 'coach',
  costPerStudent: 0,
  capacity: 40,
  emergencyContact: '',
  consentDeadline: '',
};

const emptyConsentForm = {
  studentName: '',
  className: '',
  guardianName: '',
  guardianContact: '',
  emergencyContactNumber: '',
  medicalNotes: '',
  dietaryNotes: '',
  guardianTypedName: '',
  medicalTreatmentConsent: true,
  photographyConsent: false,
  consentAcknowledged: false,
};

const formatDate = (value) => {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const FieldTrips = () => {
  const { user } = useContext(AuthContext);
  const role = getUserRole(user);
  const isStaff = role === 'teacher' || role === 'admin';

  const [tab, setTab] = useState('browse');
  const [trips, setTrips] = useState([]);
  const [registrations, setRegistrations] = useState([]);
  const [organised, setOrganised] = useState([]);
  const [manifest, setManifest] = useState(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [purposeFilter, setPurposeFilter] = useState('');
  const [openOnly, setOpenOnly] = useState(true);

  const [selectedTrip, setSelectedTrip] = useState(null);
  const [consentForm, setConsentForm] = useState(emptyConsentForm);
  const [submitting, setSubmitting] = useState(false);

  const [showTripForm, setShowTripForm] = useState(false);

  // Which trip's risk assessment is open. Null means none — the panel is not
  // shown at all rather than shown empty.
  const [riskTrip, setRiskTrip] = useState(null);
  const [tripForm, setTripForm] = useState(emptyTripForm);

  const flash = useCallback((message) => {
    setNotice(message);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const loadTrips = useCallback(async () => {
    try {
      const params = {};
      if (purposeFilter) params.purpose = purposeFilter;
      if (openOnly) params.openOnly = 'true';
      const res = await api.get('/trips', { params });
      setTrips(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load trips.');
    }
  }, [purposeFilter, openOnly]);

  const loadRegistrations = useCallback(async () => {
    try {
      const res = await api.get('/trips/my-registrations');
      setRegistrations(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadOrganised = useCallback(async () => {
    if (!isStaff) return;
    try {
      const res = await api.get('/trips/mine');
      setOrganised(res.data.data || []);
    } catch (err) {
      console.error(err);
    }
  }, [isStaff]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadTrips(), loadRegistrations(), loadOrganised()]);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTrips, loadRegistrations, loadOrganised]);

  // --- Registration --------------------------------------------------------

  const openConsent = (trip) => {
    setSelectedTrip(trip);
    setConsentForm({
      ...emptyConsentForm,
      // A sensible default the guardian can correct — most registrations are
      // made by the account holder for their own child.
      guardianName: user?.name || '',
    });
    setError('');
  };

  const submitRegistration = async (event) => {
    event.preventDefault();
    if (!selectedTrip) return;

    if (!consentForm.consentAcknowledged) {
      setError('Please read and acknowledge the consent statement.');
      return;
    }
    if (consentForm.guardianTypedName.trim().length < 3) {
      setError('Type the guardian name in full to sign the consent.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await api.post(`/trips/${selectedTrip._id}/register`, consentForm);
      flash(`${consentForm.studentName} has a seat on ${selectedTrip.title}.`);
      setSelectedTrip(null);
      setConsentForm(emptyConsentForm);
      await Promise.all([loadTrips(), loadRegistrations()]);
      setTab('mine');
    } catch (err) {
      // A 409 means the last seat went, or the trip closed, between the page
      // rendering and this request. Reload so the list stops offering it.
      setError(err.response?.data?.message || 'Could not register for that trip.');
      if (err.response?.status === 409) await loadTrips();
    } finally {
      setSubmitting(false);
    }
  };

  const withdraw = async (row) => {
    const reason = window.prompt('Why is the seat being given back? (optional)') ?? '';
    setError('');
    try {
      await api.patch(`/trips/${row.tripId}/participants/${row.participantId}/withdraw`, {
        withdrawReason: reason || null,
      });
      flash('Withdrawn. The seat is back on the list.');
      await Promise.all([loadTrips(), loadRegistrations()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw that registration.');
    }
  };

  // --- Organiser -----------------------------------------------------------

  const submitTrip = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.post('/trips', tripForm);
      flash('Trip created as a draft. Publish it when you are ready.');
      setShowTripForm(false);
      setTripForm(emptyTripForm);
      await loadOrganised();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not create that trip.');
    } finally {
      setSubmitting(false);
    }
  };

  const setTripStatus = async (trip, status) => {
    setError('');
    try {
      await api.patch(`/trips/${trip._id}/status`, { status });
      flash(`Trip is now ${status}.`);
      await Promise.all([loadOrganised(), loadTrips()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change the trip status.');
    }
  };

  const cancelTrip = async (trip) => {
    const reason = window.prompt('Why is the trip being cancelled?');
    if (!reason) return;
    setError('');
    try {
      await api.patch(`/trips/${trip._id}/cancel`, { cancelReason: reason });
      flash('Trip cancelled.');
      await Promise.all([loadOrganised(), loadTrips(), loadRegistrations()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not cancel that trip.');
    }
  };

  const openManifest = async (trip) => {
    setError('');
    try {
      const res = await api.get(`/trips/${trip._id}/manifest`);
      setManifest(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the manifest.');
    }
  };

  const markAttendance = async (participantId, present) => {
    if (!manifest) return;
    setError('');
    try {
      await api.patch(
        `/trips/${manifest.trip._id}/participants/${participantId}/attendance`,
        { present }
      );
      await openManifest({ _id: manifest.trip._id });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not mark that child.');
    }
  };

  // --- Render --------------------------------------------------------------

  const tabs = [
    { id: 'browse', label: 'Trips' },
    { id: 'mine', label: 'My registrations' },
    ...(isStaff ? [{ id: 'organise', label: 'Trips I run' }] : []),
  ];

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        Loading trips...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-2xl p-6 mb-6 text-white">
          <h1 className="text-2xl font-bold">Field trips</h1>
          <p className="text-emerald-100 mt-1 text-sm">
            Seats are held only once consent has been given, so the list on the coach and
            the list in the office are the same list.
          </p>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg bg-green-100 text-green-800 px-4 py-3 text-sm">
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-100 text-red-800 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-6 bg-white rounded-xl p-1 shadow">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={`flex-1 min-w-[130px] py-2 px-4 rounded-lg text-sm font-medium transition ${
                tab === entry.id
                  ? 'bg-emerald-600 text-white shadow'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* ---------------------------------------------------------------- */}
        {tab === 'browse' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl shadow p-4 flex flex-wrap items-center gap-4">
              <select
                value={purposeFilter}
                onChange={(event) => setPurposeFilter(event.target.value)}
                className="border rounded-lg px-3 py-2 text-sm"
              >
                <option value="">All purposes</option>
                {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={openOnly}
                  onChange={(event) => setOpenOnly(event.target.checked)}
                />
                Only trips I can still join
              </label>
            </div>

            {trips.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                No trips are open at the moment.
              </div>
            ) : (
              trips.map((trip) => (
                <div key={trip._id} className="bg-white rounded-xl shadow p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-[240px]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-lg font-semibold">{trip.title}</h2>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            TRIP_STATUS_STYLES[trip.status]
                          }`}
                        >
                          {trip.status}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {PURPOSE_LABELS[trip.purpose]}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{trip.destination}</p>
                      {trip.description && (
                        <p className="text-sm text-gray-500 mt-2">{trip.description}</p>
                      )}
                      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 mt-3 text-sm">
                        <div>
                          <dt className="inline text-gray-500">Departs: </dt>
                          <dd className="inline">
                            {formatDate(trip.departureDate)} at {trip.departureTime}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-gray-500">Returns: </dt>
                          <dd className="inline">
                            {formatDate(trip.returnDate)} at {trip.returnTime}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-gray-500">Meeting point: </dt>
                          <dd className="inline">{trip.meetingPoint}</dd>
                        </div>
                        <div>
                          <dt className="inline text-gray-500">Consent closes: </dt>
                          <dd className="inline">{formatDate(trip.consentDeadline)}</dd>
                        </div>
                      </dl>
                      {trip.eligibleClasses?.length > 0 && (
                        <p className="text-xs text-gray-500 mt-2">
                          Open to {trip.eligibleClasses.join(', ')}
                        </p>
                      )}
                    </div>

                    <div className="text-right">
                      <div className="text-2xl font-bold text-emerald-700">
                        {trip.seatsLeft}
                      </div>
                      <div className="text-xs text-gray-500">seats left</div>
                      <div className="text-sm mt-2">
                        {trip.costPerStudent > 0 ? `₹${trip.costPerStudent}` : 'Free'}
                      </div>
                      <button
                        onClick={() => openConsent(trip)}
                        disabled={!!trip.unavailableReason}
                        className="mt-3 bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Give consent
                      </button>
                      {trip.unavailableReason && (
                        <p className="text-xs text-gray-500 mt-2 max-w-[180px]">
                          {trip.unavailableReason}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'mine' && (
          <div className="space-y-3">
            {registrations.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You have not registered for any trips.
              </div>
            ) : (
              registrations.map((row) => (
                <div key={row.participantId} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{row.title}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            TRIP_STATUS_STYLES[row.tripStatus]
                          }`}
                        >
                          {row.tripStatus}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {PARTICIPANT_STATUS_LABELS[row.status]}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {PAYMENT_LABELS[row.paymentStatus]}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        {row.studentName} ({row.className}) · {row.destination}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        {formatDate(row.departureDate)} at {row.departureTime} from{' '}
                        {row.meetingPoint}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Consent signed by {row.consentSignedBy} on{' '}
                        {row.consentGivenAt
                          ? new Date(row.consentGivenAt).toLocaleDateString()
                          : '—'}
                      </p>
                      {row.cancelReason && (
                        <p className="text-xs text-red-600 mt-1">
                          Trip cancelled: {row.cancelReason}
                        </p>
                      )}
                    </div>
                    {row.canWithdraw && (
                      <button
                        onClick={() => withdraw(row)}
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        Withdraw
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {tab === 'organise' && isStaff && (
          <div className="space-y-4">
            <button
              onClick={() => setShowTripForm((current) => !current)}
              className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-500"
            >
              {showTripForm ? 'Close' : 'Plan a trip'}
            </button>

            {/* A trip cannot open until its assessment is approved, so the
                assessment belongs on the screen where the trip is published
                rather than behind a separate route. */}
            {riskTrip && (
              <RiskAssessmentPanel tripId={riskTrip._id} tripTitle={riskTrip.title} />
            )}

            {showTripForm && (
              <form onSubmit={submitTrip} className="bg-white rounded-xl shadow p-5 grid sm:grid-cols-2 gap-4">
                {[
                  { field: 'title', label: 'Title', type: 'text', required: true },
                  { field: 'destination', label: 'Destination', type: 'text', required: true },
                  { field: 'departureDate', label: 'Departure date', type: 'date', required: true },
                  { field: 'returnDate', label: 'Return date', type: 'date', required: true },
                  { field: 'departureTime', label: 'Departure time', type: 'time', required: true },
                  { field: 'returnTime', label: 'Return time', type: 'time', required: true },
                  { field: 'meetingPoint', label: 'Meeting point', type: 'text', required: true },
                  { field: 'consentDeadline', label: 'Consent closes', type: 'date', required: true },
                  { field: 'capacity', label: 'Seats', type: 'number', required: true },
                  { field: 'costPerStudent', label: 'Cost per student', type: 'number', required: false },
                  { field: 'emergencyContact', label: 'Emergency contact', type: 'text', required: true },
                ].map((input) => (
                  <label key={input.field} className="text-sm">
                    <span className="block text-gray-500 mb-1">{input.label}</span>
                    <input
                      type={input.type}
                      required={input.required}
                      value={tripForm[input.field]}
                      onChange={(event) =>
                        setTripForm({ ...tripForm, [input.field]: event.target.value })
                      }
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </label>
                ))}

                <label className="text-sm">
                  <span className="block text-gray-500 mb-1">Purpose</span>
                  <select
                    value={tripForm.purpose}
                    onChange={(event) =>
                      setTripForm({ ...tripForm, purpose: event.target.value })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  >
                    {Object.entries(PURPOSE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm sm:col-span-2">
                  <span className="block text-gray-500 mb-1">Description</span>
                  <textarea
                    rows={3}
                    value={tripForm.description}
                    onChange={(event) =>
                      setTripForm({ ...tripForm, description: event.target.value })
                    }
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </label>

                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {submitting ? 'Creating...' : 'Create draft'}
                  </button>
                </div>
              </form>
            )}

            {organised.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-sm text-gray-500">
                You are not organising or escorting any trips.
              </div>
            ) : (
              organised.map((trip) => (
                <div key={trip._id} className="bg-white rounded-xl shadow p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{trip.title}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            TRIP_STATUS_STYLES[trip.status]
                          }`}
                        >
                          {trip.status}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        {formatDate(trip.departureDate)} · {trip.destination}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        {trip.confirmedCount} of {trip.capacity} seats taken
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {trip.status === 'draft' && (
                        <button
                          onClick={() => setTripStatus(trip, 'open')}
                          className="text-sm bg-emerald-600 text-white px-3 py-1.5 rounded-lg hover:bg-emerald-500"
                        >
                          Publish
                        </button>
                      )}
                      {trip.status === 'open' && (
                        <button
                          onClick={() => setTripStatus(trip, 'closed')}
                          className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                        >
                          Close list
                        </button>
                      )}
                      <button
                        onClick={() =>
                          setRiskTrip((current) =>
                            current && current._id === trip._id ? null : trip
                          )
                        }
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        {riskTrip && riskTrip._id === trip._id ? 'Hide risk' : 'Risk assessment'}
                      </button>
                      <button
                        onClick={() => openManifest(trip)}
                        className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                      >
                        Manifest
                      </button>
                      {trip.status !== 'cancelled' && trip.status !== 'completed' && (
                        <button
                          onClick={() => cancelTrip(trip)}
                          className="text-sm text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Consent form ---------------------------------------------------- */}
        {selectedTrip && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <form
              onSubmit={submitRegistration}
              className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[88vh] overflow-y-auto p-6 space-y-4"
            >
              <div>
                <h3 className="text-lg font-semibold">{selectedTrip.title}</h3>
                <p className="text-sm text-gray-500">
                  {formatDate(selectedTrip.departureDate)} at {selectedTrip.departureTime} ·{' '}
                  {selectedTrip.destination}
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                {[
                  { field: 'studentName', label: 'Student name', required: true },
                  { field: 'className', label: 'Class', required: true },
                  { field: 'guardianName', label: 'Guardian name', required: true },
                  { field: 'guardianContact', label: 'Contact number', required: true },
                  { field: 'emergencyContactNumber', label: 'Second contact number', required: false },
                ].map((input) => (
                  <label key={input.field} className="text-sm">
                    <span className="block text-gray-500 mb-1">{input.label}</span>
                    <input
                      type="text"
                      required={input.required}
                      value={consentForm[input.field]}
                      onChange={(event) =>
                        setConsentForm({ ...consentForm, [input.field]: event.target.value })
                      }
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </label>
                ))}
              </div>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">
                  Medical notes — allergies, medication, anything an escort must know
                </span>
                <textarea
                  rows={3}
                  value={consentForm.medicalNotes}
                  onChange={(event) =>
                    setConsentForm({ ...consentForm, medicalNotes: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">Dietary notes</span>
                <input
                  type="text"
                  value={consentForm.dietaryNotes}
                  onChange={(event) =>
                    setConsentForm({ ...consentForm, dietaryNotes: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <div className="bg-gray-50 border rounded-lg p-4 text-sm text-gray-700 space-y-2">
                {CONSENT_STATEMENT.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>

              <div className="space-y-2 text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={consentForm.medicalTreatmentConsent}
                    onChange={(event) =>
                      setConsentForm({
                        ...consentForm,
                        medicalTreatmentConsent: event.target.checked,
                      })
                    }
                    className="mt-1"
                  />
                  <span>
                    I consent to emergency first aid or medical treatment being given if
                    the escort cannot reach me.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={consentForm.photographyConsent}
                    onChange={(event) =>
                      setConsentForm({
                        ...consentForm,
                        photographyConsent: event.target.checked,
                      })
                    }
                    className="mt-1"
                  />
                  <span>Photographs of my child may be used in school publications.</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={consentForm.consentAcknowledged}
                    onChange={(event) =>
                      setConsentForm({
                        ...consentForm,
                        consentAcknowledged: event.target.checked,
                      })
                    }
                    className="mt-1"
                  />
                  <span>I have read the statement above and agree to it.</span>
                </label>
              </div>

              <label className="text-sm block">
                <span className="block text-gray-500 mb-1">
                  Type the guardian name in full to sign
                </span>
                <input
                  type="text"
                  required
                  value={consentForm.guardianTypedName}
                  onChange={(event) =>
                    setConsentForm({ ...consentForm, guardianTypedName: event.target.value })
                  }
                  className="w-full border rounded-lg px-3 py-2"
                />
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedTrip(null)}
                  className="text-sm border border-gray-300 px-4 py-2 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="text-sm bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-500 disabled:opacity-50"
                >
                  {submitting ? 'Submitting...' : 'Sign and take the seat'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Manifest -------------------------------------------------------- */}
        {manifest && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[88vh] overflow-y-auto p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold">{manifest.trip.title}</h3>
                  <p className="text-sm text-gray-500">
                    {formatDate(manifest.trip.departureDate)} at {manifest.trip.departureTime}{' '}
                    from {manifest.trip.meetingPoint}
                  </p>
                  <p className="text-sm text-gray-500">
                    Emergency contact: {manifest.trip.emergencyContact}
                  </p>
                </div>
                <button
                  onClick={() => setManifest(null)}
                  className="text-sm border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-5">
                {[
                  { label: 'Travelling', value: manifest.summary.travelling },
                  { label: 'Medical notes', value: manifest.summary.withMedicalNotes },
                  {
                    label: 'No treatment consent',
                    value: manifest.summary.withoutMedicalTreatmentConsent,
                  },
                  { label: 'Unpaid', value: manifest.summary.unpaid },
                ].map((stat) => (
                  <div key={stat.label} className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-xl font-bold">{stat.value}</div>
                    <div className="text-xs text-gray-500">{stat.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                {manifest.data.map((row) => (
                  <div key={row.participantId} className="border rounded-lg p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">
                          {row.studentName}{' '}
                          <span className="text-gray-500 text-sm">({row.className})</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {row.guardianName} · {row.guardianContact}
                          {row.emergencyContactNumber
                            ? ` · ${row.emergencyContactNumber}`
                            : ''}
                        </div>
                        {row.medicalNotes && (
                          <div className="mt-2 text-sm bg-red-50 text-red-800 rounded px-2 py-1">
                            {row.medicalNotes}
                          </div>
                        )}
                        {row.dietaryNotes && (
                          <div className="mt-1 text-sm text-gray-600">
                            Diet: {row.dietaryNotes}
                          </div>
                        )}
                        {row.medicalTreatmentConsent === false && (
                          <div className="mt-1 text-xs font-medium text-red-700">
                            No consent for emergency treatment — call the guardian.
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => markAttendance(row.participantId, true)}
                          className={`text-xs px-3 py-1.5 rounded-lg ${
                            row.status === 'attended'
                              ? 'bg-green-600 text-white'
                              : 'border border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          Present
                        </button>
                        <button
                          onClick={() => markAttendance(row.participantId, false)}
                          className={`text-xs px-3 py-1.5 rounded-lg ${
                            row.status === 'absent'
                              ? 'bg-red-600 text-white'
                              : 'border border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          Absent
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FieldTrips;
