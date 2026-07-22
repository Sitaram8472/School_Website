const Course = require("../models/Course");

exports.createCourse = async (req, res) => {
  try {
    const { name, description } = req.body;
    const course = new Course({
      name,
      description,
      teacher: req.user.id,
    });
    await course.save();
    res.status(201).json({ success: true, data: course });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.getCourses = async (req, res) => {
  try {
    const courses = await Course.find();
    res.status(200).json({ success: true, data: courses });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.updateCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (req.permissionType === 'own' && course.teacher.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    const updatedCourse = await Course.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.status(200).json({ success: true, data: updatedCourse });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

exports.deleteCourse = async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) {
      return res.status(404).json({ success: false, message: 'Course not found' });
    }

    if (req.permissionType === 'own' && course.teacher.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have permission to perform this action.' });
    }

    await course.deleteOne();
    res.status(200).json({ success: true, message: 'Course deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};
