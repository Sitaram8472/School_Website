const Exam = require("../models/Exam");

exports.createExam = async (req, res) => {
  try {
    const exam = new Exam({ ...req.body, creator: req.user.id });
    await exam.save();
    res.status(201).json({ success: true, data: exam });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.getExamsForCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const filter = { course: courseId };
    
    // Students only see published exams
    if (req.user.role === 'student') {
      filter.isPublished = true;
    }

    const exams = await Exam.find(filter).populate('course', 'name');
    res.status(200).json({ success: true, data: exams });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.getAllExams = async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === 'student') filter.isPublished = true;
    
    const exams = await Exam.find(filter).populate('course', 'name').populate('creator', 'name');
    res.status(200).json({ success: true, data: exams });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.getExam = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ success: false, error: "Exam not found" });

    // Hide answers from students
    if (req.user.role === 'student') {
      if (!exam.isPublished) {
        return res.status(403).json({ success: false, error: "Access denied. This exam is not published." });
      }
      const examData = exam.toObject();
      examData.questions.forEach(q => delete q.correctAnswer);
      return res.status(200).json({ success: true, data: examData });
    }

    res.status(200).json({ success: true, data: exam });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.updateExam = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

    if (req.permissionType === 'own' && exam.creator.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    const updatedExam = await Exam.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.status(200).json({ success: true, data: updatedExam });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.deleteExam = async (req, res) => {
  try {
    const exam = await Exam.findById(req.params.id);
    if (!exam) return res.status(404).json({ success: false, message: 'Exam not found' });

    if (req.permissionType === 'own' && exam.creator.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    await exam.deleteOne();
    res.status(200).json({ success: true, message: 'Exam deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
