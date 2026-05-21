// import ki jagah require karo
const Inquiry = require("../models/Inquiry");

const createInquiry = async (req, res) => {
  try {
    const { name, email, department, message } = req.body;
    console.log(req.body);

    if (!name || !email || !department || !message) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    const inquiry = await Inquiry.create({
      name, email, department, message,
    });
    console.log(inquiry);

    return res.status(201).json({
      success: true,
      message: "Inquiry submitted successfully",
      inquiry,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

// export ki jagah module.exports karo
module.exports = { createInquiry };