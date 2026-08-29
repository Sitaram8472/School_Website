import React, { useState, useEffect, useCallback } from 'react';
import {
  HeartPulse,
  Plus,
  X,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Search,
  Trash2,
  CalendarClock,
  PhoneCall,
} from 'lucide-react';
import api from '../../utils/axios';

const OUTCOMES = [
  { value: 'returned-to-class', label: 'Returned to class' },
  { value: 'rested-in-infirmary', label: 'Rested in the infirmary' },
  { value: 'sent-home', label: 'Sent home' },
  { value: 'referred-to-hospital', label: 'Referred to hospital' },
];

// Kept in step with OUTCOMES_REQUIRING_NOTIFICATION on the server. The server
// is the one that enforces it; this only lets the form say so before the save
// bounces.
const OUTCOMES_NEEDING_PARENT = ['sent-home', 'referred-to-hospital'];

const OUTCOME_STYLES = {
  'returned-to-class': 'bg-green-100 text-green-700',
  'rested-in-infirmary': 'bg-blue-100 text-blue-700',
  'sent-home': 'bg-amber-100 text-amber-800',
  'referred-to-hospital': 'bg-red-100 text-red-700',
};

const EMPTY_VISIT = {
  studentId: '',
  className: '',
  complaint: '',
  symptoms: '',
  temperatureCelsius: '',
  bloodPressure: '',
  pulseBpm: '',
  treatmentGiven: '',
  outcome: 'returned-to-class',
  restDurationMinutes: 0,
  parentNotified: false,
  notifiedVia: 'phone',
  followUpRequired: false,
  followUpOn: '',
  notes: '',
};

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const InfirmaryPanel = () => {
  const [summary, setSummary] = useState(null);
  const [visits, setVisits] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_VISIT);
  const [medications, setMedications] = useState([]);

  // The alerts the nurse should see *before* recording treatment.
  const [alerts, setAlerts] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [search, setSearch] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const flash = (message) => {
    setSuccess(message);
    setTimeout(() => setSuccess(''), 4000);
  };

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get('/health/infirmary/summary');
      setSummary(res.data.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the infirmary summary.');
    }
  }, []);

  const loadVisits = useCallback(async () => {
    try {
      const params = { limit: 100 };
      if (outcomeFilter) params.outcome = outcomeFilter;
      if (search.trim()) params.search = search.trim();

      const res = await api.get('/health/visits', { params });
      setVisits(res.data.data || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load visits.');
    }
  }, [outcomeFilter, search]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadSummary(), loadVisits()]);
      setLoading(false);
    };
    load();
    // loadVisits changes with the filters, which is exactly when we want a refetch.
  }, [loadSummary, loadVisits]);

  /**
   * Pulls the student's critical alerts as soon as an id is entered, so the
   * nurse sees "severe penicillin allergy" before they write the treatment,
   * not after.
   */
  const lookupAlerts = async (studentId) => {
    if (!studentId || studentId.trim().length < 12) {
      setAlerts(null);
      return;
    }

    setLookupBusy(true);
    try {
      const res = await api.get(`/health/profiles/${studentId.trim()}/alerts`);
      setAlerts(res.data.hasProfile ? res.data.data : { alerts: [], noProfile: true });
    } catch {
      setAlerts(null);
    } finally {
      setLookupBusy(false);
    }
  };

  const addMedication = () => setMedications((prev) => [...prev, { name: '', dosage: '' }]);

  const updateMedication = (index, field, value) => {
    setMedications((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const removeMedication = (index) =>
    setMedications((prev) => prev.filter((_, i) => i !== index));

  const needsParent = OUTCOMES_NEEDING_PARENT.includes(form.outcome);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    if (!form.studentId.trim()) {
      setError('Enter the student id.');
      return;
    }
    if (form.complaint.trim().length < 3) {
      setError('Describe the complaint.');
      return;
    }
    if (needsParent && !form.parentNotified) {
      setError(
        `"${form.outcome}" means the child left the school's care — confirm the parent was told first.`
      );
      return;
    }
    if (form.followUpRequired && !form.followUpOn) {
      setError('A follow-up needs a date.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...form,
        symptoms: form.symptoms
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        temperatureCelsius: form.temperatureCelsius ? Number(form.temperatureCelsius) : undefined,
        pulseBpm: form.pulseBpm ? Number(form.pulseBpm) : undefined,
        restDurationMinutes: Number(form.restDurationMinutes) || 0,
        medicationsAdministered: medications.filter((med) => med.name.trim()),
      };

      await api.post('/health/visits', payload);

      flash('Visit recorded.');
      setForm(EMPTY_VISIT);
      setMedications([]);
      setAlerts(null);
      setShowForm(false);
      await Promise.all([loadSummary(), loadVisits()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record that visit.');
    } finally {
      setSaving(false);
    }
  };

  const handleNotifyParent = async (visit) => {
    setError('');
    try {
      await api.patch(`/health/visits/${visit._id}/notify-parent`, { via: 'phone' });
      flash('Marked as notified.');
      await Promise.all([loadSummary(), loadVisits()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update that visit.');
    }
  };

  const handleCompleteFollowUp = async (visit) => {
    setError('');
    try {
      await api.patch(`/health/visits/${visit._id}/complete-follow-up`, {});
      flash('Follow-up closed.');
      await Promise.all([loadSummary(), loadVisits()]);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not close that follow-up.');
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-2xl shadow p-10 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-t-4 border-b-4 border-rose-500" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ---- Summary tiles ---- */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Visits today', value: summary.visitsToday },
            { label: 'This week', value: summary.visitsThisWeek },
            { label: 'Sent home', value: summary.sentHomeThisWeek },
            { label: 'Open follow-ups', value: summary.openFollowUps },
          ].map((tile) => (
            <div key={tile.label} className="bg-white rounded-xl shadow p-4 text-center">
              <div className="text-xl font-bold text-gray-800">{tile.value}</div>
              <div className="text-xs text-gray-500 mt-1">{tile.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Students with severe allergies ---- */}
      {summary?.studentsWithSevereAllergies?.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
          <h4 className="text-sm font-bold text-red-800 flex items-center gap-2 mb-3">
            <AlertTriangle size={16} /> Students with severe allergies
          </h4>
          <div className="flex flex-wrap gap-2">
            {summary.studentsWithSevereAllergies.map((entry, index) => (
              <span
                key={`${entry.studentName}-${index}`}
                className="text-xs bg-white border border-red-200 text-red-800 px-3 py-1.5 rounded-full"
              >
                {entry.studentName}
                {entry.className && <span className="text-red-400"> · {entry.className}</span>}
                <span className="text-red-500"> — {entry.allergens.join(', ')}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {summary?.topComplaints?.length > 0 && (
        <div className="bg-white rounded-2xl shadow p-5">
          <h4 className="text-sm font-semibold text-gray-700 mb-3">
            Most common complaints this week
          </h4>
          <div className="space-y-2">
            {summary.topComplaints.map((item) => (
              <div key={item.complaint} className="flex items-center gap-3">
                <span className="text-xs text-gray-600 w-40 truncate capitalize">
                  {item.complaint}
                </span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-400"
                    style={{
                      width: `${(item.count / summary.topComplaints[0].count) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-xs text-gray-400 w-6 text-right">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <HeartPulse size={18} className="text-rose-500" /> Infirmary log
        </h3>
        <button
          onClick={() => {
            setShowForm(!showForm);
            setError('');
          }}
          className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition flex items-center gap-1.5"
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? 'Close' : 'Record a visit'}
        </button>
      </div>

      {/* ---- Visit form ---- */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow p-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Student id</label>
              <input
                value={form.studentId}
                onChange={(e) => setForm({ ...form, studentId: e.target.value })}
                onBlur={(e) => lookupAlerts(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
              {lookupBusy && <p className="text-[11px] text-gray-400 mt-1">Checking record…</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Class</label>
              <input
                value={form.className}
                onChange={(e) => setForm({ ...form, className: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          {/* Alerts shown before treatment is written, not after. */}
          {alerts && (
            <div
              className={`rounded-xl px-4 py-3 border ${
                alerts.alerts?.length
                  ? 'bg-red-50 border-red-200'
                  : 'bg-gray-50 border-gray-200'
              }`}
            >
              {alerts.noProfile ? (
                <p className="text-xs text-gray-500">No health profile on file for that student.</p>
              ) : alerts.alerts?.length ? (
                <>
                  <p className="text-xs font-bold text-red-800 flex items-center gap-1.5 mb-2">
                    <AlertTriangle size={13} /> {alerts.studentName} · blood group{' '}
                    {alerts.bloodGroup}
                  </p>
                  <ul className="space-y-1">
                    {alerts.alerts.map((alert, index) => (
                      <li key={index} className="text-xs text-red-700">
                        <strong>{alert.label}</strong> — {alert.detail}
                      </li>
                    ))}
                  </ul>
                  {alerts.primaryContact && (
                    <p className="text-[11px] text-red-600 mt-2">
                      Primary contact: {alerts.primaryContact.name} ({alerts.primaryContact.relation}
                      ) · {alerts.primaryContact.phone}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-500">
                  No critical alerts on file · blood group {alerts.bloodGroup}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Complaint</label>
            <input
              value={form.complaint}
              onChange={(e) => setForm({ ...form, complaint: e.target.value })}
              placeholder="Headache since morning assembly"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Symptoms (comma separated)
            </label>
            <input
              value={form.symptoms}
              onChange={(e) => setForm({ ...form, symptoms: e.target.value })}
              placeholder="nausea, dizziness"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Temp (°C)</label>
              <input
                type="number"
                step="0.1"
                value={form.temperatureCelsius}
                onChange={(e) => setForm({ ...form, temperatureCelsius: e.target.value })}
                placeholder="37.2"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">BP</label>
              <input
                value={form.bloodPressure}
                onChange={(e) => setForm({ ...form, bloodPressure: e.target.value })}
                placeholder="120/80"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Pulse</label>
              <input
                type="number"
                value={form.pulseBpm}
                onChange={(e) => setForm({ ...form, pulseBpm: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Rest (min)</label>
              <input
                type="number"
                min="0"
                value={form.restDurationMinutes}
                onChange={(e) => setForm({ ...form, restDurationMinutes: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Treatment given</label>
            <textarea
              rows="2"
              value={form.treatmentGiven}
              onChange={(e) => setForm({ ...form, treatmentGiven: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
            />
          </div>

          {/* ---- Medications ---- */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600">Medication administered</label>
              <button
                type="button"
                onClick={addMedication}
                className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              >
                <Plus size={13} /> Add
              </button>
            </div>

            {medications.length === 0 ? (
              <p className="text-xs text-gray-400">None.</p>
            ) : (
              <div className="space-y-2">
                {medications.map((med, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <input
                      value={med.name}
                      onChange={(e) => updateMedication(index, 'name', e.target.value)}
                      placeholder="Paracetamol"
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                    <input
                      value={med.dosage}
                      onChange={(e) => updateMedication(index, 'dosage', e.target.value)}
                      placeholder="250 mg"
                      className="w-32 px-3 py-2 border border-gray-200 rounded-lg text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => removeMedication(index)}
                      className="text-gray-400 hover:text-red-500"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Outcome</label>
              <select
                value={form.outcome}
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
              >
                {OUTCOMES.map((outcome) => (
                  <option key={outcome.value} value={outcome.value}>
                    {outcome.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <label
                className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg w-full ${
                  needsParent && !form.parentNotified
                    ? 'bg-amber-50 border border-amber-200 text-amber-800'
                    : 'text-gray-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={form.parentNotified}
                  onChange={(e) => setForm({ ...form, parentNotified: e.target.checked })}
                />
                Parent notified{needsParent && ' (required)'}
              </label>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.followUpRequired}
                onChange={(e) => setForm({ ...form, followUpRequired: e.target.checked })}
              />
              Follow-up required
            </label>

            {form.followUpRequired && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Follow-up on</label>
                <input
                  type="date"
                  value={form.followUpOn}
                  onChange={(e) => setForm({ ...form, followUpOn: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"
                />
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm px-5 py-2.5 rounded-lg transition"
          >
            {saving ? 'Saving…' : 'Record visit'}
          </button>
        </form>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by student…"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm"
          />
        </div>
        <select
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-200 text-sm"
        >
          <option value="">All outcomes</option>
          {OUTCOMES.map((outcome) => (
            <option key={outcome.value} value={outcome.value}>
              {outcome.label}
            </option>
          ))}
        </select>
      </div>

      {/* ---- Visit list ---- */}
      <div className="bg-white rounded-2xl shadow p-5">
        {visits.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">No visits match those filters.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {visits.map((visit) => (
              <li key={visit._id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800">
                      {visit.studentName}
                      {visit.className && (
                        <span className="text-xs text-gray-400 ml-2">{visit.className}</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-600 mt-0.5">{visit.complaint}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {formatDateTime(visit.visitedAt)}
                      {visit.temperatureCelsius && ` · ${visit.temperatureCelsius}°C`}
                      {visit.attendedBy?.name && ` · ${visit.attendedBy.name}`}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <span
                      className={`text-[11px] px-2.5 py-1 rounded-full ${
                        OUTCOME_STYLES[visit.outcome] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {OUTCOMES.find((o) => o.value === visit.outcome)?.label || visit.outcome}
                    </span>

                    <div className="flex gap-2">
                      {!visit.parentNotified && (
                        <button
                          onClick={() => handleNotifyParent(visit)}
                          className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"
                        >
                          <PhoneCall size={11} /> Mark notified
                        </button>
                      )}
                      {visit.followUpRequired && !visit.followUpCompleted && (
                        <button
                          onClick={() => handleCompleteFollowUp(visit)}
                          className="text-[11px] text-green-600 hover:underline flex items-center gap-1"
                        >
                          <CalendarClock size={11} /> Close follow-up
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default InfirmaryPanel;
