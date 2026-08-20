const AnalyticsEvent = require('../models/AnalyticsEvent');
const mongoose = require('mongoose');

// @desc    Get dashboard analytics overview
// @route   GET /api/analytics/overview
// @access  Private/Admin
const getAnalyticsOverview = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. DAU and MAU
    // Daily Active Users (DAU): Count of distinct users grouped by day
    const dauAggregation = await AnalyticsEvent.aggregate([
      {
        $match: {
          eventType: 'LOGIN',
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" },
            userId: "$userId"
          }
        }
      },
      {
        $group: {
          _id: {
            year: "$_id.year",
            month: "$_id.month",
            day: "$_id.day"
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 }
      },
      {
        $project: {
          _id: 0,
          date: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: {
                $dateFromParts: {
                  year: "$_id.year",
                  month: "$_id.month",
                  day: "$_id.day"
                }
              }
            }
          },
          count: 1
        }
      }
    ]);

    // Monthly Active Users (MAU) - Simple calculation: distinct users in the last 30 days
    const mauAggregation = await AnalyticsEvent.distinct('userId', {
      eventType: 'LOGIN',
      createdAt: { $gte: thirtyDaysAgo }
    });
    const mau = mauAggregation.length;

    // 2. Most downloaded resources
    const topResources = await AnalyticsEvent.aggregate([
      {
        $match: {
          eventType: 'RESOURCE_DOWNLOAD'
        }
      },
      {
        $group: {
          _id: "$resourceId",
          downloads: { $sum: 1 }
        }
      },
      {
        $sort: { downloads: -1 }
      },
      {
        $limit: 5
      },
      {
        $lookup: {
          from: 'resources',
          localField: '_id',
          foreignField: '_id',
          as: 'resourceDetails'
        }
      },
      {
        $unwind: "$resourceDetails"
      },
      {
        $project: {
          _id: 1,
          downloads: 1,
          title: "$resourceDetails.title",
          subject: "$resourceDetails.subject"
        }
      }
    ]);

    // 3. AI Queries per day
    const aiQueriesAggregation = await AnalyticsEvent.aggregate([
      {
        $match: {
          eventType: 'AI_QUERY',
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            day: { $dayOfMonth: "$createdAt" }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 }
      },
      {
        $project: {
          _id: 0,
          date: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: {
                $dateFromParts: {
                  year: "$_id.year",
                  month: "$_id.month",
                  day: "$_id.day"
                }
              }
            }
          },
          count: 1
        }
      }
    ]);

    // Distribution of User Roles
    const rolesDistribution = await mongoose.model('User').aggregate([
      {
        $group: {
          _id: "$role",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          role: "$_id",
          count: 1
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        dau: dauAggregation,
        mau,
        topResources,
        aiQueries: aiQueriesAggregation,
        rolesDistribution
      }
    });

  } catch (error) {
    console.error("Error generating analytics:", error);
    res.status(500).json({ success: false, message: "Server Error", error: error.message });
  }
};

module.exports = {
  getAnalyticsOverview
};
