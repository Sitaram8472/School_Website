const mongoose = require('mongoose');

const BusRoute = require('../models/BusRoute');
const TransportAssignment = require('../models/TransportAssignment');
const User = require('../models/User');

const STAFF_ROLES = ['admin', 'staff'];

/**
 * Every handler funnels its failures through here. A `userFacing` error (thrown
 * by the models or by the guards below) is something the caller can fix, so it
 * gets its own status; anything else is a bug and must not leak a stack trace.
 */
const fail = (res, error, fallbackStatus = 400) => {
  if (error && error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'That record already exists',
    });
  }

  if (error && error.userFacing) {
    return res.status(error.statusCode || fallbackStatus).json({
      success: false,
      message: error.message,
    });
  }

  console.error('[Transport]', error);
  return res.status(500).json({ success: false, message: 'Something went wrong on our side' });
};

const conflict = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = 409;
  return error;
};

const forbidden = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = 403;
  return error;
};

const notFound = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = 404;
  return error;
};

const badRequest = (message) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = 400;
  return error;
};

const isStaff = (user) => STAFF_ROLES.includes(user?.role);

// Longest search term we will build a pattern from. Beyond this it is a probe,
// not a search.
const MAX_SEARCH_LENGTH = 80;

/**
 * Builds a case-insensitive "contains" matcher from untrusted input.
 *
 * The metacharacters must be escaped. Passed through raw, a search of `.*`
 * quietly matches every route, and `(a+)+$` drives the regex engine into
 * catastrophic backtracking — a 33-character query string is enough to pin a
 * CPU core for around two minutes. Escaping makes the term literal, which is
 * what someone typing into a search box expects in the first place.
 */
const searchPattern = (value) => {
  const term = String(value).trim().slice(0, MAX_SEARCH_LENGTH);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
};

const asObjectId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
};

/**
 * Recomputes `seatsOccupied` from the assignments that actually exist rather
 * than incrementing a counter at each call site. Slightly more work per write,
 * but the number cannot drift — which is the whole reason the office abandoned
 * their spreadsheet.
 */
const syncSeatCount = async (routeId) => {
  const occupied = await TransportAssignment.countDocuments({
    route: routeId,
    status: 'active',
  });

  await BusRoute.updateOne({ _id: routeId }, { $set: { seatsOccupied: occupied } });
  return occupied;
};

// ---------------------------------------------------------------------------
// Routes (the bus kind)
// ---------------------------------------------------------------------------

exports.createRoute = async (req, res) => {
  try {
    const { routeCode, routeName, description, vehicle, driver, attendant, stops, operatingDays, farePerMonth, notes } =
      req.body;

    if (!Array.isArray(stops) || stops.length < 2) {
      throw badRequest('A route needs at least two stops — a boarding point and the school');
    }

    const existing = await BusRoute.findOne({ routeCode: String(routeCode || '').toUpperCase() });
    if (existing) {
      throw conflict(`Route code ${existing.routeCode} is already in use`);
    }

    const route = new BusRoute({
      routeCode,
      routeName,
      description,
      vehicle,
      driver,
      attendant,
      stops,
      operatingDays,
      farePerMonth,
      notes,
      createdBy: req.user.id || req.user._id,
      // Never trusted from the body — a fresh route starts empty and the
      // counter is only ever moved by syncSeatCount().
      seatsOccupied: 0,
    });

    route.resequenceStops();
    await route.save();

    return res.status(201).json({ success: true, data: route });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRoutes = async (req, res) => {
  try {
    const { status, search, hasSeats, limit = 50, page = 1 } = req.query;

    const filter = {};

    // Students browsing the catalogue only ever see routes that are running.
    if (!isStaff(req.user)) {
      filter.status = 'active';
    } else if (status) {
      filter.status = status;
    }

    if (search) {
      const pattern = searchPattern(search);
      filter.$or = [{ routeCode: pattern }, { routeName: pattern }, { 'stops.name': pattern }];
    }

    const perPage = Math.min(Number(limit) || 50, 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    let routes = await BusRoute.find(filter).sort({ routeCode: 1 }).skip(skip).limit(perPage);

    if (hasSeats === 'true') {
      routes = routes.filter((route) => route.seatsAvailable > 0);
    }

    const total = await BusRoute.countDocuments(filter);

    return res.status(200).json({
      success: true,
      count: routes.length,
      total,
      page: Math.max(Number(page) || 1, 1),
      data: routes,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRoute = async (req, res) => {
  try {
    asObjectId(req.params.id, 'route id');

    const route = await BusRoute.findById(req.params.id).populate('createdBy', 'name email');
    if (!route) throw notFound('Route not found');

    if (!isStaff(req.user) && route.status !== 'active') {
      throw forbidden('This route is not currently running');
    }

    return res.status(200).json({
      success: true,
      data: { ...route.toObject(), stops: route.orderedStops() },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.updateRoute = async (req, res) => {
  try {
    asObjectId(req.params.id, 'route id');

    const route = await BusRoute.findById(req.params.id);
    if (!route) throw notFound('Route not found');

    // Fields the client is allowed to move. `seatsOccupied`, `routeCode` and
    // `createdBy` are deliberately absent: the first is derived, the second is
    // the identity other records point at, the third is history.
    const editable = [
      'routeName',
      'description',
      'vehicle',
      'driver',
      'attendant',
      'operatingDays',
      'farePerMonth',
      'notes',
      'status',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) {
        route[field] = req.body[field];
      }
    });

    if (req.body.status === 'retired') {
      const live = await TransportAssignment.countDocuments({ route: route._id, status: 'active' });
      if (live > 0) {
        throw conflict(
          `Cannot retire this route — ${live} student${live === 1 ? ' is' : 's are'} still assigned to it`
        );
      }
    }

    await route.save();

    return res.status(200).json({ success: true, data: route });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Replaces the whole stop list in one shot. Editing stops one at a time made
 * reordering fiddly for the UI and left windows where sequences were invalid,
 * so the panel sends the full ordered list and the server renumbers it.
 */
exports.replaceStops = async (req, res) => {
  try {
    asObjectId(req.params.id, 'route id');

    const { stops } = req.body;
    if (!Array.isArray(stops) || stops.length < 2) {
      throw badRequest('A route needs at least two stops');
    }

    const route = await BusRoute.findById(req.params.id);
    if (!route) throw notFound('Route not found');

    // Any stop currently referenced by a live assignment must survive the edit,
    // otherwise a student ends up assigned to a stop the bus no longer visits.
    const liveAssignments = await TransportAssignment.find({
      route: route._id,
      status: 'active',
    }).select('pickupStop dropStop studentName');

    const incomingNames = new Set(stops.map((s) => String(s.name || '').trim().toLowerCase()));

    const orphaned = liveAssignments.filter(
      (a) =>
        !incomingNames.has(a.pickupStop.trim().toLowerCase()) ||
        !incomingNames.has(a.dropStop.trim().toLowerCase())
    );

    if (orphaned.length) {
      const names = orphaned.map((a) => a.studentName || 'a student').slice(0, 5).join(', ');
      throw conflict(
        `Removing those stops would strand ${orphaned.length} assigned student(s): ${names}`
      );
    }

    route.stops = stops.map((stop, index) => ({
      name: stop.name,
      landmark: stop.landmark || '',
      pickupTime: stop.pickupTime,
      dropTime: stop.dropTime,
      sequence: index + 1,
      latitude: stop.latitude ?? null,
      longitude: stop.longitude ?? null,
    }));

    await route.save();

    return res.status(200).json({
      success: true,
      message: 'Stops updated',
      data: { ...route.toObject(), stops: route.orderedStops() },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.deleteRoute = async (req, res) => {
  try {
    asObjectId(req.params.id, 'route id');

    const route = await BusRoute.findById(req.params.id);
    if (!route) throw notFound('Route not found');

    const live = await TransportAssignment.countDocuments({ route: route._id, status: 'active' });
    if (live > 0) {
      throw conflict(`Cannot delete this route — ${live} active assignment(s) still point at it`);
    }

    await route.deleteOne();

    return res.status(200).json({ success: true, message: 'Route deleted' });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

exports.assignStudent = async (req, res) => {
  try {
    const { studentId, routeId, pickupStop, dropStop, direction, startDate, emergencyContact, notes } =
      req.body;

    asObjectId(studentId, 'student id');
    asObjectId(routeId, 'route id');

    const [student, route] = await Promise.all([
      User.findById(studentId).select('name email role'),
      BusRoute.findById(routeId),
    ]);

    if (!student) throw notFound('Student not found');
    if (student.role !== 'student') throw badRequest('Only students can be assigned to a bus route');
    if (!route) throw notFound('Route not found');

    if (route.status !== 'active') {
      throw conflict(`Route ${route.routeCode} is ${route.status} and cannot take new riders`);
    }

    if (!route.hasStop(pickupStop)) {
      throw badRequest(`"${pickupStop}" is not a stop on route ${route.routeCode}`);
    }
    if (!route.hasStop(dropStop)) {
      throw badRequest(`"${dropStop}" is not a stop on route ${route.routeCode}`);
    }

    const alreadyRiding = await TransportAssignment.findOne({
      student: studentId,
      status: 'active',
    }).populate('route', 'routeCode');

    if (alreadyRiding) {
      throw conflict(
        `${student.name} is already assigned to route ${alreadyRiding.route?.routeCode || 'another route'}. Cancel that first.`
      );
    }

    // Re-derive occupancy immediately before the capacity check so a stale
    // counter can never let one extra child onto a full bus.
    const occupied = await syncSeatCount(route._id);
    if (occupied + 1 > route.vehicle.capacity) {
      throw conflict(
        `Route ${route.routeCode} is full (${occupied}/${route.vehicle.capacity} seats taken)`
      );
    }

    const assignment = await TransportAssignment.create({
      student: studentId,
      studentName: student.name,
      className: req.body.className || '',
      route: route._id,
      routeCode: route.routeCode,
      pickupStop: route.findStop(pickupStop).name,
      dropStop: route.findStop(dropStop).name,
      direction: direction || 'both',
      startDate: startDate || new Date(),
      monthlyFare: route.farePerMonth,
      emergencyContact,
      notes,
      assignedBy: req.user.id || req.user._id,
    });

    await syncSeatCount(route._id);

    return res.status(201).json({ success: true, data: assignment });
  } catch (error) {
    return fail(res, error);
  }
};

exports.cancelAssignment = async (req, res) => {
  try {
    asObjectId(req.params.id, 'assignment id');

    const assignment = await TransportAssignment.findById(req.params.id);
    if (!assignment) throw notFound('Assignment not found');

    assignment.cancel(req.body.reason || 'Cancelled by the transport office', req.user.id);
    await assignment.save();

    await syncSeatCount(assignment.route);

    return res.status(200).json({
      success: true,
      message: 'Assignment cancelled and the seat has been freed',
      data: assignment,
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * What the logged-in student sees on `/transport`: their live assignment, the
 * full stop timeline of their route, and which stop is theirs.
 */
exports.getMyTransport = async (req, res) => {
  try {
    const assignment = await TransportAssignment.findOne({
      student: req.user.id || req.user._id,
      status: 'active',
    }).populate('route');

    if (!assignment) {
      return res.status(200).json({
        success: true,
        assigned: false,
        message: 'You are not currently assigned to a school bus',
        data: null,
      });
    }

    const route = assignment.route;
    const stops = route ? route.orderedStops() : [];

    return res.status(200).json({
      success: true,
      assigned: true,
      data: {
        assignment,
        route: route ? { ...route.toObject(), stops } : null,
        myPickup: stops.find((s) => s.name === assignment.pickupStop) || null,
        myDrop: stops.find((s) => s.name === assignment.dropStop) || null,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getStudentAssignment = async (req, res) => {
  try {
    asObjectId(req.params.studentId, 'student id');

    const requesterId = String(req.user.id || req.user._id);
    if (!isStaff(req.user) && requesterId !== String(req.params.studentId)) {
      throw forbidden('You can only view your own transport assignment');
    }

    const assignments = await TransportAssignment.find({ student: req.params.studentId })
      .populate('route', 'routeCode routeName driver vehicle status')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: assignments.length, data: assignments });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * The printable roster: every rider on a route, ordered by where they board, so
 * the driver's sheet matches the order stops are actually reached.
 */
exports.getRouteRoster = async (req, res) => {
  try {
    asObjectId(req.params.id, 'route id');

    const route = await BusRoute.findById(req.params.id);
    if (!route) throw notFound('Route not found');

    const assignments = await TransportAssignment.find({ route: route._id, status: 'active' })
      .populate('student', 'name email')
      .lean();

    const stopOrder = new Map(route.orderedStops().map((stop, index) => [stop.name, index]));

    assignments.sort((a, b) => {
      const left = stopOrder.get(a.pickupStop) ?? 999;
      const right = stopOrder.get(b.pickupStop) ?? 999;
      if (left !== right) return left - right;
      return (a.studentName || '').localeCompare(b.studentName || '');
    });

    // Group by stop so the sheet reads the way the driver works: one block per
    // stop, in the order the bus reaches them.
    const byStop = route.orderedStops().map((stop) => ({
      stop: stop.name,
      pickupTime: stop.pickupTime,
      dropTime: stop.dropTime,
      riders: assignments.filter((a) => a.pickupStop === stop.name),
    }));

    return res.status(200).json({
      success: true,
      data: {
        route: {
          routeCode: route.routeCode,
          routeName: route.routeName,
          driver: route.driver,
          vehicle: route.vehicle,
          seatsOccupied: route.seatsOccupied,
          seatsAvailable: route.seatsAvailable,
        },
        totalRiders: assignments.length,
        byStop,
        riders: assignments,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Fleet-level numbers for the panel header. Cheap enough to run on every panel
 * load; if it ever stops being cheap it is a single aggregate to cache.
 */
exports.getTransportSummary = async (req, res) => {
  try {
    const routes = await BusRoute.find({});

    const activeRoutes = routes.filter((r) => r.status === 'active');
    const totalCapacity = activeRoutes.reduce((sum, r) => sum + (r.vehicle?.capacity || 0), 0);
    const totalOccupied = activeRoutes.reduce((sum, r) => sum + (r.seatsOccupied || 0), 0);

    const busiest = [...activeRoutes]
      .sort((a, b) => b.occupancyRate - a.occupancyRate)
      .slice(0, 5)
      .map((r) => ({
        routeCode: r.routeCode,
        routeName: r.routeName,
        occupancyRate: r.occupancyRate,
        seatsOccupied: r.seatsOccupied,
        capacity: r.vehicle?.capacity || 0,
      }));

    return res.status(200).json({
      success: true,
      data: {
        totalRoutes: routes.length,
        activeRoutes: activeRoutes.length,
        suspendedRoutes: routes.filter((r) => r.status === 'suspended').length,
        totalCapacity,
        totalOccupied,
        seatsFree: Math.max(totalCapacity - totalOccupied, 0),
        fleetOccupancyRate: totalCapacity ? Math.round((totalOccupied / totalCapacity) * 100) : 0,
        busiest,
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Admin repair hatch. If assignments were ever changed outside the controller,
 * this walks every route and rewrites the derived counter from the source data.
 */
exports.recomputeOccupancy = async (req, res) => {
  try {
    const routes = await BusRoute.find({}).select('_id routeCode');
    const results = [];

    for (const route of routes) {
      const occupied = await syncSeatCount(route._id);
      results.push({ routeCode: route.routeCode, seatsOccupied: occupied });
    }

    return res.status(200).json({
      success: true,
      message: `Recomputed occupancy for ${results.length} route(s)`,
      data: results,
    });
  } catch (error) {
    return fail(res, error);
  }
};
