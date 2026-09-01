const Resource = require("../models/Resource");

// Get search filter
const getSearchFilter = (req, fields) => {
  const search = req.query.search;
  if (!search) return {};
  return {
    $or: fields.map(field => ({
      [field]: { $regex: search, $options: 'i' }
    }))
  };
};

// Get pagination params
const getPagination = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

exports.getResources = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req);
    const searchFilter = getSearchFilter(req, ['title', 'subject']);

    const filter = {
      deletedAt: null,
      ...searchFilter
    };

    const [resources, total] = await Promise.all([
      Resource.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Resource.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      message: "Resources fetched successfully",
      resources,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};
