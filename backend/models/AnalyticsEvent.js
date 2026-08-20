const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      enum: ['LOGIN', 'RESOURCE_DOWNLOAD', 'AI_QUERY'],
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Resource',
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes to speed up aggregation queries
analyticsEventSchema.index({ eventType: 1, createdAt: 1 });
analyticsEventSchema.index({ createdAt: 1 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
