const mongoose = require('mongoose');

const HostelRoom = require('../models/HostelRoom');
const RoomAllocation = require('../models/RoomAllocation');
const User = require('../models/User');

const WARDEN_ROLES = ['admin', 'staff'];

const fail = (res, error, fallbackStatus = 400) => {
  if (error && error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages.join(', ') });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'That room already exists, or the student already holds a live allocation',
    });
  }

  if (error && error.userFacing) {
    return res
      .status(error.statusCode || fallbackStatus)
      .json({ success: false, message: error.message });
  }

  console.error('[Hostel]', error);
  return res.status(500).json({ success: false, message: 'Something went wrong on our side' });
};

const makeError = (message, statusCode) => {
  const error = new Error(message);
  error.userFacing = true;
  error.statusCode = statusCode;
  return error;
};

const badRequest = (message) => makeError(message, 400);
const forbidden = (message) => makeError(message, 403);
const notFound = (message) => makeError(message, 404);
const conflict = (message) => makeError(message, 409);

const isWarden = (user) => WARDEN_ROLES.includes(user?.role);

// Longest search term we will build a pattern from. Beyond this it is a probe,
// not a search.
const MAX_SEARCH_LENGTH = 80;

/**
 * Escapes regex metacharacters so untrusted input is matched literally.
 *
 * Passed through raw, a search of `.*` quietly matches every room, and
 * `(a+)+$` drives the regex engine into catastrophic backtracking — a
 * 33-character query string is enough to pin a CPU core for around two
 * minutes. An unbalanced `[` throws and surfaces as a 500 rather than a 400.
 */
const escapeRegex = (value) =>
  String(value).trim().slice(0, MAX_SEARCH_LENGTH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive "contains" matcher over untrusted input. */
const searchPattern = (value) => new RegExp(escapeRegex(value), 'i');

/** Case-insensitive "starts with" matcher, used to select a block by prefix. */
const prefixPattern = (value) => new RegExp(`^${escapeRegex(value)}`, 'i');

const assertObjectId = (value, label = 'id') => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw badRequest(`Invalid ${label}`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

exports.createRoom = async (req, res) => {
  try {
    const {
      roomNumber,
      block,
      floor,
      hostelType,
      roomType,
      capacity,
      amenities,
      monthlyRent,
      wardenName,
      wardenPhone,
      notes,
    } = req.body;

    const room = new HostelRoom({
      roomNumber,
      block,
      floor,
      hostelType,
      roomType,
      capacity,
      amenities,
      monthlyRent,
      wardenName,
      wardenPhone,
      notes,
      // Beds are generated from capacity by the model — a client-supplied bed
      // list would let someone create a room that starts out "occupied".
      beds: [],
    });

    await room.save();

    return res.status(201).json({ success: true, data: room });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRooms = async (req, res) => {
  try {
    const { block, hostelType, roomType, status, available, search, limit = 100, page = 1 } =
      req.query;

    const filter = {};
    if (block) filter.block = String(block).toUpperCase();
    if (hostelType) filter.hostelType = hostelType;
    if (roomType) filter.roomType = roomType;
    if (status) filter.status = status;

    if (search) {
      const pattern = searchPattern(search);
      filter.$or = [{ roomNumber: pattern }, { block: pattern }, { wardenName: pattern }];
    }

    const perPage = Math.min(Number(limit) || 100, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    let rooms = await HostelRoom.find(filter)
      .sort({ block: 1, floor: 1, roomNumber: 1 })
      .skip(skip)
      .limit(perPage);

    // Filtered after the query because "has a vacant bed" is a virtual derived
    // from the bed array rather than a stored field.
    if (available === 'true') {
      rooms = rooms.filter((room) => room.canAcceptOccupant());
    }

    const total = await HostelRoom.countDocuments(filter);

    return res.status(200).json({
      success: true,
      count: rooms.length,
      total,
      page: Math.max(Number(page) || 1, 1),
      data: rooms,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getRoom = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'room id');

    const room = await HostelRoom.findById(req.params.id).populate('beds.occupant', 'name email');
    if (!room) throw notFound('Room not found');

    const allocations = await RoomAllocation.find({ room: room._id })
      .sort({ allocatedFrom: -1 })
      .limit(50);

    return res.status(200).json({
      success: true,
      data: { room, allocations },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.updateRoom = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'room id');

    const room = await HostelRoom.findById(req.params.id);
    if (!room) throw notFound('Room not found');

    // `beds` and `occupiedBeds` are absent on purpose: both are derived, and
    // letting a client post them is how a bed ends up "vacant" with a student
    // still living in it.
    const editable = [
      'floor',
      'roomType',
      'capacity',
      'amenities',
      'monthlyRent',
      'wardenName',
      'wardenPhone',
      'notes',
      'status',
    ];

    editable.forEach((field) => {
      if (req.body[field] !== undefined) {
        room[field] = req.body[field];
      }
    });

    if (req.body.status === 'closed' && room.occupiedBeds > 0) {
      throw conflict(
        `Cannot close ${room.label} — ${room.occupiedBeds} student(s) still live there`
      );
    }

    await room.save();

    return res.status(200).json({ success: true, data: room });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Takes a single bed out of service (or puts it back). Kept separate from the
 * room update so blocking a bed never accidentally rewrites room-level fields.
 */
exports.setBedStatus = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'room id');

    const { bedNumber, status, reason } = req.body;
    if (!['vacant', 'blocked'].includes(status)) {
      throw badRequest('A bed can only be set to vacant or blocked here — use allocate to occupy it');
    }

    const room = await HostelRoom.findById(req.params.id);
    if (!room) throw notFound('Room not found');

    const bed = room.findBed(bedNumber);
    if (!bed) throw notFound(`Room ${room.label} has no bed "${bedNumber}"`);

    if (bed.status === 'occupied') {
      throw conflict(
        `Bed ${room.label}/${bed.bedNumber} is occupied — vacate the student before changing it`
      );
    }

    bed.status = status;
    bed.blockedReason = status === 'blocked' ? reason || 'Out of service' : '';
    room.markModified('beds');

    await room.save();

    return res.status(200).json({ success: true, data: room });
  } catch (error) {
    return fail(res, error);
  }
};

exports.deleteRoom = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'room id');

    const room = await HostelRoom.findById(req.params.id);
    if (!room) throw notFound('Room not found');

    const live = await RoomAllocation.countDocuments({ room: room._id, status: 'active' });
    if (live > 0) {
      throw conflict(`Cannot delete ${room.label} — ${live} student(s) are still allocated to it`);
    }

    await room.deleteOne();

    return res.status(200).json({ success: true, message: 'Room deleted' });
  } catch (error) {
    return fail(res, error);
  }
};

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

/**
 * Shared by allocate and transfer. Occupies the bed and opens the allocation
 * row, saving the room first: if the allocation write then fails, the worst
 * case is a bed marked occupied with no row, which `recomputeOccupancy` below
 * repairs. The reverse order would hand the same bed to two students.
 */
const placeStudent = async ({ student, room, bedNumber, className, guardian, actorId, notes }) => {
  room.occupyBed(bedNumber, student._id, student.name);
  await room.save();

  try {
    return await RoomAllocation.create({
      student: student._id,
      studentName: student.name,
      className: className || '',
      room: room._id,
      roomLabel: room.label,
      bedNumber: String(bedNumber).toUpperCase(),
      allocatedBy: actorId,
      guardianName: guardian?.name || '',
      guardianPhone: guardian?.phone || '',
      notes: notes || '',
    });
  } catch (error) {
    // Give the bed back rather than leaving it stranded.
    try {
      room.releaseBedFor(student._id);
      await room.save();
    } catch (rollbackError) {
      console.error('[Hostel] could not roll back a bed after a failed allocation', rollbackError);
    }
    throw error;
  }
};

exports.allocateRoom = async (req, res) => {
  try {
    const { studentId, roomId, bedNumber, className, guardianName, guardianPhone, notes } = req.body;

    assertObjectId(studentId, 'student id');
    assertObjectId(roomId, 'room id');

    const [student, room] = await Promise.all([
      User.findById(studentId).select('name email role'),
      HostelRoom.findById(roomId),
    ]);

    if (!student) throw notFound('Student not found');
    if (student.role !== 'student') throw badRequest('Only students can be allocated a hostel bed');
    if (!room) throw notFound('Room not found');

    const existing = await RoomAllocation.findOne({ student: studentId, status: 'active' });
    if (existing) {
      throw conflict(
        `${student.name} already has a bed in ${existing.roomLabel}. Use transfer to move them.`
      );
    }

    const allocation = await placeStudent({
      student,
      room,
      bedNumber,
      className,
      guardian: { name: guardianName, phone: guardianPhone },
      actorId: req.user.id || req.user._id,
      notes,
    });

    return res.status(201).json({ success: true, data: { allocation, room } });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Moves a student to a different bed. The old allocation is closed as
 * `transferred` and linked to the new one, so the history reads as a chain
 * rather than a vacate followed by an unrelated allocation.
 */
exports.transferRoom = async (req, res) => {
  try {
    const { studentId, toRoomId, bedNumber, reason } = req.body;

    assertObjectId(studentId, 'student id');
    assertObjectId(toRoomId, 'room id');

    const current = await RoomAllocation.findOne({ student: studentId, status: 'active' });
    if (!current) throw notFound('That student does not currently hold a hostel allocation');

    if (String(current.room) === String(toRoomId) && current.bedNumber === String(bedNumber).toUpperCase()) {
      throw badRequest('The student is already in that bed');
    }

    const [student, fromRoom, toRoom] = await Promise.all([
      User.findById(studentId).select('name email role'),
      HostelRoom.findById(current.room),
      HostelRoom.findById(toRoomId),
    ]);

    if (!student) throw notFound('Student not found');
    if (!toRoom) throw notFound('Destination room not found');

    if (student.role === 'student' && toRoom.hostelType && fromRoom?.hostelType) {
      if (toRoom.hostelType !== fromRoom.hostelType) {
        throw badRequest(
          `Cannot move between a ${fromRoom.hostelType} and a ${toRoom.hostelType} hostel`
        );
      }
    }

    // Close the old row first so the partial unique index on an active
    // allocation does not reject the new one.
    current.close('transferred', reason || 'Transferred to another room');
    await current.save();

    if (fromRoom) {
      try {
        fromRoom.releaseBedFor(studentId);
        await fromRoom.save();
      } catch (error) {
        console.error('[Hostel] old bed was already free during a transfer', error.message);
      }
    }

    let allocation;
    try {
      allocation = await placeStudent({
        student,
        room: toRoom,
        bedNumber,
        className: current.className,
        guardian: { name: current.guardianName, phone: current.guardianPhone },
        actorId: req.user.id || req.user._id,
        notes: `Transferred from ${current.roomLabel}`,
      });
    } catch (error) {
      // Put the student back where they were so a failed move is not a lost bed.
      current.status = 'active';
      current.vacatedAt = null;
      current.allocatedTo = null;
      current.vacateReason = '';
      await current.save();

      if (fromRoom) {
        try {
          fromRoom.occupyBed(current.bedNumber, student._id, student.name);
          await fromRoom.save();
        } catch (rollbackError) {
          console.error('[Hostel] could not restore the original bed', rollbackError.message);
        }
      }
      throw error;
    }

    current.transferredTo = allocation._id;
    await current.save();

    return res.status(200).json({
      success: true,
      message: `${student.name} moved from ${current.roomLabel} to ${toRoom.label}`,
      data: { allocation, previous: current },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.vacateRoom = async (req, res) => {
  try {
    assertObjectId(req.params.id, 'allocation id');

    const allocation = await RoomAllocation.findById(req.params.id);
    if (!allocation) throw notFound('Allocation not found');

    allocation.close('vacated', req.body.reason || 'Vacated');
    await allocation.save();

    const room = await HostelRoom.findById(allocation.room);
    if (room) {
      try {
        room.releaseBedFor(allocation.student);
        await room.save();
      } catch (error) {
        console.error('[Hostel] bed was already free on vacate', error.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Bed vacated. The allocation is kept as history.',
      data: allocation,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getMyRoom = async (req, res) => {
  try {
    const studentId = req.user.id || req.user._id;

    const allocation = await RoomAllocation.findOne({ student: studentId, status: 'active' })
      .populate('room')
      .populate('allocatedBy', 'name');

    const history = await RoomAllocation.find({ student: studentId })
      .sort({ allocatedFrom: -1 })
      .limit(20);

    if (!allocation) {
      return res.status(200).json({
        success: true,
        allocated: false,
        message: 'You do not currently have a hostel room',
        data: null,
        history,
      });
    }

    // Roommates are useful and not sensitive — a boarder can see who is in the
    // room with them, and nothing more.
    const roommates = (allocation.room?.beds || [])
      .filter((bed) => bed.status === 'occupied' && String(bed.occupant) !== String(studentId))
      .map((bed) => ({ bedNumber: bed.bedNumber, name: bed.occupantName }));

    return res.status(200).json({
      success: true,
      allocated: true,
      data: { allocation, room: allocation.room, roommates },
      history,
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getStudentAllocations = async (req, res) => {
  try {
    assertObjectId(req.params.studentId, 'student id');

    const requesterId = String(req.user.id || req.user._id);
    if (!isWarden(req.user) && requesterId !== String(req.params.studentId)) {
      throw forbidden('You can only view your own hostel allocation');
    }

    const allocations = await RoomAllocation.find({ student: req.params.studentId })
      .populate('room', 'block roomNumber hostelType wardenName wardenPhone')
      .sort({ allocatedFrom: -1 });

    return res.status(200).json({ success: true, count: allocations.length, data: allocations });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Block-level occupancy for the warden's dashboard. One pass over the rooms
 * rather than an aggregate pipeline — the room count is in the hundreds, not
 * the millions, and this stays readable.
 */
exports.getOccupancySummary = async (req, res) => {
  try {
    const rooms = await HostelRoom.find({});

    const blocks = new Map();

    rooms.forEach((room) => {
      const key = room.block;
      if (!blocks.has(key)) {
        blocks.set(key, {
          block: key,
          hostelType: room.hostelType,
          rooms: 0,
          capacity: 0,
          occupied: 0,
          blocked: 0,
          maintenance: 0,
        });
      }

      const entry = blocks.get(key);
      entry.rooms += 1;
      entry.capacity += room.capacity || 0;
      entry.occupied += room.occupiedBeds || 0;
      entry.blockedBeds = (entry.blockedBeds || 0) + room.blockedBeds;
      if (room.status === 'maintenance') entry.maintenance += 1;
    });

    const byBlock = [...blocks.values()].map((entry) => ({
      ...entry,
      free: Math.max(entry.capacity - entry.occupied, 0),
      occupancyRate: entry.capacity ? Math.round((entry.occupied / entry.capacity) * 100) : 0,
    }));

    const totalCapacity = byBlock.reduce((sum, b) => sum + b.capacity, 0);
    const totalOccupied = byBlock.reduce((sum, b) => sum + b.occupied, 0);

    const activeBoarders = await RoomAllocation.countDocuments({ status: 'active' });

    return res.status(200).json({
      success: true,
      data: {
        totalRooms: rooms.length,
        totalCapacity,
        totalOccupied,
        totalFree: Math.max(totalCapacity - totalOccupied, 0),
        occupancyRate: totalCapacity ? Math.round((totalOccupied / totalCapacity) * 100) : 0,
        activeBoarders,
        roomsUnderMaintenance: rooms.filter((r) => r.status === 'maintenance').length,
        byBlock: byBlock.sort((a, b) => a.block.localeCompare(b.block)),
      },
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getBoarders = async (req, res) => {
  try {
    const { block, search, limit = 200 } = req.query;

    const filter = { status: 'active' };
    if (search) {
      const pattern = searchPattern(search);
      filter.$or = [{ studentName: pattern }, { roomLabel: pattern }];
    }
    if (block) {
      filter.roomLabel = prefixPattern(`${String(block).toUpperCase()}-`);
    }

    const boarders = await RoomAllocation.find(filter)
      .populate('student', 'name email')
      .sort({ roomLabel: 1, bedNumber: 1 })
      .limit(Math.min(Number(limit) || 200, 500));

    return res.status(200).json({ success: true, count: boarders.length, data: boarders });
  } catch (error) {
    return fail(res, error);
  }
};

/**
 * Repair hatch. Rebuilds every room's bed occupancy from the allocation
 * collection, which is the authority on who lives where.
 */
exports.recomputeOccupancy = async (req, res) => {
  try {
    const rooms = await HostelRoom.find({});
    const repaired = [];

    for (const room of rooms) {
      const live = await RoomAllocation.find({ room: room._id, status: 'active' });
      const byBed = new Map(live.map((a) => [a.bedNumber, a]));
      let changed = false;

      room.beds.forEach((bed) => {
        const allocation = byBed.get(bed.bedNumber);

        if (allocation && bed.status !== 'occupied') {
          bed.status = 'occupied';
          bed.occupant = allocation.student;
          bed.occupantName = allocation.studentName;
          changed = true;
        } else if (!allocation && bed.status === 'occupied') {
          bed.status = 'vacant';
          bed.occupant = null;
          bed.occupantName = '';
          changed = true;
        }
      });

      if (changed) {
        room.markModified('beds');
        await room.save();
        repaired.push(room.label);
      }
    }

    return res.status(200).json({
      success: true,
      message: repaired.length
        ? `Repaired ${repaired.length} room(s)`
        : 'Every room already matched its allocations',
      data: repaired,
    });
  } catch (error) {
    return fail(res, error);
  }
};
