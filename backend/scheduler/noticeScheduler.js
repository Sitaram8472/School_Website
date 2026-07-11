// backend/scheduler/noticeScheduler.js
const cron = require('node-cron');
const Notice = require('../models/Notice');
const logger = require('../config/logger');

const checkAndProcessNotices = async () => {
  const now = new Date();

  logger.info('Checking notices', {
    timestamp: now.toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });

  try {
    const publishResult = await Notice.updateMany(
      {
        status: 'scheduled',
        publishAt: { $lte: now }
      },
      {
        $set: {
          status: 'published',
          publishedAt: now,
          date: now
        }
      }
    );

    if (publishResult.modifiedCount > 0) {
      logger.info('Auto-published scheduled notices', {
        count: publishResult.modifiedCount,
        action: 'publish'
      });
    }

    const archiveResult = await Notice.updateMany(
      {
        status: 'published',
        expiresAt: { $lte: now }
      },
      {
        $set: {
          status: 'archived'
        }
      }
    );

    if (archiveResult.modifiedCount > 0) {
      logger.info('Auto-archived expired notices', {
        count: archiveResult.modifiedCount,
        action: 'archive'
      });
    }

    if (publishResult.modifiedCount === 0 && archiveResult.modifiedCount === 0) {
      logger.debug('No notices to process');
    }

  } catch (error) {
    logger.error('Error running notice cron job', {
      error: error.message,
      stack: error.stack
    });
  }
};

cron.schedule('* * * * *', checkAndProcessNotices);

logger.info('Notice background scheduler initialized', {
  schedule: '* * * * *',
  status: 'running'
});

module.exports = { checkAndProcessNotices };