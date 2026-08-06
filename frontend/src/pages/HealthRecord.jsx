import React, { useState, useEffect, useCallback, useContext, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  HeartPulse,
  AlertTriangle,
  Syringe,
  Phone,
  Stethoscope,
  Droplet,
  AlertCircle,
  Activity,
  CalendarClock,
} from 'lucide-react';
import api from '../utils/axios';
import { AuthContext } from '../context/AuthContext';

const OUTCOME_LABELS = {
  'returned-to-class': 'Returned to class',
  'rested-in-infirmary': 'Rested in the infirmary',
  'sent-home': 'Sent home',
  'referred-to-hospital': 'Referred to hospital',
};

const OUTCOME_STYLES = {
  'returned-to-class': 'bg-green-100 text-green-700',
  'rested-in-infirmary': 'bg-blue-100 text-blue-700',
  'sent-home': 'bg-amber-100 text-amber-800',
  'referred-to-hospital': 'bg-red-100 text-red-700',
};

const SEVERITY_STYLES = {
  mild: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  moderate: 'bg-orange-50 text-orange-800 border-orange-200',
  severe: 'bg-red-50 text-red-800 border-red-200',
};

const formatDate = (value) =>
  value
    ? new Date(value).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/**
 * BMI is shown with a plain-language band rather than a bare number, because a
 * number on its own tells a fourteen-year-old nothing useful.
 */
const bmiBand = (bmi) => {
  if (!bmi) return null;
  if (bmi < 18.5) return { label: 'Below the healthy range', tone: 'text-amber-600' };
  if (bmi < 25) return { label: 'Healthy range', tone: 'text-green-600' };
  if (bmi < 30) return { label: 'Above the healthy range', tone: 'text-amber-600' };
  return { label: 'Well above the healthy range', tone: 'text-red-600' };
};

const HealthRecord = () => {
  const { user } = useContext(AuthContext);
  const displayName = user?.name || user?.user?.name || 'Student';

  const [profile, setProfile] = useState(null);
  const [hasProfile, setHasProfile] = useState(false);
  const [visits, setVisits] = useState([]);
  const [overdueVaccinations, setOverdueVaccinations] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/health/me');
      setHasProfile(Boolean(res.data.hasProfile));
      setProfile(res.data.data);
      setVisits(res.data.visits || []);
      setOverdueVaccinations(res.data.overdueVaccinations || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your health record right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const band = useMemo(() => bmiBand(profile?.bmi), [profile]);

  const upcomingVaccinations = useMemo(
    () =>
      (profile?.vaccinations || [])
        .filter((shot) => shot.nextDueOn)
        .sort((a, b) => new Date(a.nextDueOn) - new Date(b.nextDueOn)),
    [profile]
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-rose-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link
          to="/student"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft size={16} /> Back to dashboard
        </Link>

        <div className="bg-gradient-to-r from-rose-500 to-red-600 rounded-2xl p-6 mb-6 text-white">
          <div className="flex items-center gap-3">
            <HeartPulse size={30} />
            <div>
              <h1 className="text-2xl font-bold">Health Record</h1>
              <p className="text-rose-50 text-sm mt-0.5">
                {displayName} · visible only to you and the school infirmary
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!hasProfile ? (
          <div className="bg-white rounded-2xl shadow p-8 text-center mb-6">
            <HeartPulse size={40} className="mx-auto text-gray-300 mb-3" />
            <h2 className="font-bold text-gray-800 text-lg">No health profile yet</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              The school infirmary has not recorded your medical details. Ask the office to add your
              blood group, allergies and an emergency contact — it matters most on the day nobody
              has time to ask.
            </p>
          </div>
        ) : (
          <>
            {/* ---- Critical alerts ---- */}
            {(profile.criticalAlerts || []).length > 0 && (
              <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-5 mb-6">
                <h3 className="font-bold text-red-800 flex items-center gap-2 mb-3">
                  <AlertTriangle size={18} /> Critical alerts
                </h3>
                <div className="space-y-2">
                  {profile.criticalAlerts.map((alert, index) => (
                    <div
                      key={`${alert.kind}-${index}`}
                      className="bg-white rounded-xl px-4 py-3 border border-red-100"
                    >
                      <p className="text-sm font-semibold text-gray-800">
                        {alert.label}
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-red-500">
                          {alert.kind}
                        </span>
                      </p>
                      <p className="text-xs text-gray-600 mt-0.5">{alert.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ---- Vitals ---- */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <Droplet size={18} className="mx-auto text-rose-500 mb-1.5" />
                <div className="text-lg font-bold text-gray-800">{profile.bloodGroup}</div>
                <div className="text-[11px] text-gray-500">Blood group</div>
              </div>
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <Activity size={18} className="mx-auto text-rose-500 mb-1.5" />
                <div className="text-lg font-bold text-gray-800">{profile.bmi ?? '—'}</div>
                <div className={`text-[11px] ${band?.tone || 'text-gray-500'}`}>
                  {band?.label || 'BMI'}
                </div>
              </div>
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-lg font-bold text-gray-800 mt-6">
                  {profile.heightCm ? `${profile.heightCm} cm` : '—'}
                </div>
                <div className="text-[11px] text-gray-500">Height</div>
              </div>
              <div className="bg-white rounded-xl shadow p-4 text-center">
                <div className="text-lg font-bold text-gray-800 mt-6">
                  {profile.weightKg ? `${profile.weightKg} kg` : '—'}
                </div>
                <div className="text-[11px] text-gray-500">Weight</div>
              </div>
            </div>

            {/* ---- Allergies & conditions ---- */}
            <div className="grid gap-5 sm:grid-cols-2 mb-6">
              <div className="bg-white rounded-2xl shadow p-5">
                <h3 className="font-bold text-gray-800 mb-3 text-sm">Allergies</h3>
                {(profile.allergies || []).length === 0 ? (
                  <p className="text-sm text-gray-400">None recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {profile.allergies.map((allergy) => (
                      <li
                        key={allergy._id || allergy.allergen}
                        className={`rounded-xl border px-3 py-2 ${
                          SEVERITY_STYLES[allergy.severity] || 'bg-gray-50 border-gray-200'
                        }`}
                      >
                        <p className="text-sm font-semibold">
                          {allergy.allergen}
                          <span className="ml-2 text-[11px] uppercase">{allergy.severity}</span>
                        </p>
                        {allergy.reaction && (
                          <p className="text-xs mt-0.5 opacity-80">{allergy.reaction}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-white rounded-2xl shadow p-5">
                <h3 className="font-bold text-gray-800 mb-3 text-sm">Ongoing conditions</h3>
                {(profile.chronicConditions || []).length === 0 ? (
                  <p className="text-sm text-gray-400">None recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {profile.chronicConditions.map((condition) => (
                      <li
                        key={condition._id || condition.condition}
                        className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2"
                      >
                        <p className="text-sm font-semibold text-gray-800">
                          {condition.condition}
                          {!condition.isActive && (
                            <span className="ml-2 text-[11px] text-gray-400">resolved</span>
                          )}
                        </p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {condition.medication || 'No medication recorded'}
                          {condition.diagnosedOn && ` · since ${formatDate(condition.diagnosedOn)}`}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* ---- Vaccinations ---- */}
            <div className="bg-white rounded-2xl shadow p-5 mb-6">
              <h3 className="font-bold text-gray-800 mb-3 text-sm flex items-center gap-2">
                <Syringe size={16} className="text-rose-500" /> Vaccinations
              </h3>

              {overdueVaccinations.length > 0 && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                  <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
                    <CalendarClock size={13} />
                    {overdueVaccinations.length} dose(s) are now due
                  </p>
                  <p className="text-xs text-amber-700 mt-1">
                    {overdueVaccinations.map((shot) => shot.vaccine).join(', ')}
                  </p>
                </div>
              )}

              {(profile.vaccinations || []).length === 0 ? (
                <p className="text-sm text-gray-400">None recorded.</p>
              ) : (
                <ol className="relative border-l-2 border-dashed border-rose-200 ml-2">
                  {upcomingVaccinations.concat(
                    (profile.vaccinations || []).filter((shot) => !shot.nextDueOn)
                  ).map((shot) => (
                    <li key={shot._id || `${shot.vaccine}-${shot.doseNumber}`} className="mb-4 ml-5">
                      <span className="absolute -left-[7px] w-3 h-3 rounded-full bg-rose-400 ring-4 ring-white" />
                      <p className="text-sm font-semibold text-gray-800">
                        {shot.vaccine}
                        <span className="text-xs text-gray-400 ml-2">dose {shot.doseNumber}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Given {formatDate(shot.administeredOn)}
                        {shot.nextDueOn && ` · next due ${formatDate(shot.nextDueOn)}`}
                        {shot.provider && ` · ${shot.provider}`}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {/* ---- Contacts ---- */}
            <div className="grid gap-5 sm:grid-cols-2 mb-6">
              <div className="bg-white rounded-2xl shadow p-5">
                <h3 className="font-bold text-gray-800 mb-3 text-sm">Emergency contacts</h3>
                {(profile.emergencyContacts || []).length === 0 ? (
                  <p className="text-sm text-gray-400">None recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {profile.emergencyContacts.map((contact) => (
                      <li
                        key={contact._id || contact.phone}
                        className={`rounded-xl px-3 py-2 border ${
                          contact.isPrimary
                            ? 'border-rose-200 bg-rose-50'
                            : 'border-gray-200 bg-gray-50'
                        }`}
                      >
                        <p className="text-sm font-semibold text-gray-800">
                          {contact.name}
                          {contact.isPrimary && (
                            <span className="ml-2 text-[10px] bg-rose-600 text-white px-2 py-0.5 rounded-full">
                              primary
                            </span>
                          )}
                        </p>
                        <a
                          href={`tel:${contact.phone}`}
                          className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-0.5"
                        >
                          <Phone size={11} /> {contact.phone} · {contact.relation}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-white rounded-2xl shadow p-5">
                <h3 className="font-bold text-gray-800 mb-3 text-sm flex items-center gap-2">
                  <Stethoscope size={16} className="text-rose-500" /> Physician
                </h3>
                {profile.physician?.name ? (
                  <>
                    <p className="text-sm font-semibold text-gray-800">{profile.physician.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{profile.physician.hospital}</p>
                    {profile.physician.phone && (
                      <a
                        href={`tel:${profile.physician.phone}`}
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1"
                      >
                        <Phone size={11} /> {profile.physician.phone}
                      </a>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-400">Not recorded.</p>
                )}

                {(profile.dietaryRestrictions || []).length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-gray-400 mb-1.5">
                      Dietary restrictions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {profile.dietaryRestrictions.map((item) => (
                        <span
                          key={item}
                          className="text-[11px] bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ---- Infirmary visits ---- */}
        <div className="bg-white rounded-2xl shadow p-5">
          <h3 className="font-bold text-gray-800 mb-4 text-sm">Infirmary visits</h3>

          {visits.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">
              You have not visited the infirmary.
            </p>
          ) : (
            <ul className="space-y-3">
              {visits.map((visit) => (
                <li key={visit._id} className="border border-gray-100 rounded-xl px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-800">{visit.complaint}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatDateTime(visit.visitedAt)}
                        {visit.attendedBy?.name && ` · seen by ${visit.attendedBy.name}`}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] px-2.5 py-1 rounded-full shrink-0 ${
                        OUTCOME_STYLES[visit.outcome] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {OUTCOME_LABELS[visit.outcome] || visit.outcome}
                    </span>
                  </div>

                  {visit.treatmentGiven && (
                    <p className="text-xs text-gray-600 mt-2">{visit.treatmentGiven}</p>
                  )}

                  {(visit.medicationsAdministered || []).length > 0 && (
                    <p className="text-[11px] text-gray-500 mt-1.5">
                      Given:{' '}
                      {visit.medicationsAdministered
                        .map((med) => `${med.name}${med.dosage ? ` (${med.dosage})` : ''}`)
                        .join(', ')}
                    </p>
                  )}

                  {visit.followUpRequired && !visit.followUpCompleted && (
                    <p className="text-[11px] text-amber-700 mt-1.5 flex items-center gap-1">
                      <CalendarClock size={11} /> Follow-up on {formatDate(visit.followUpOn)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default HealthRecord;
