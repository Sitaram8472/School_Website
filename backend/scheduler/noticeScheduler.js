const cron = require('node-cron');
const Notice = require('../models/Notice');

const checkAndProcessNotices = async () => {
  const now = new Date();
  console.log(`[Scheduler] Checking notices at ${now.toISOString()}`);

  try {
    // 1. Publish scheduled notices in one query using updateMany
    const publishResult = await Notice.updateMany(
      {
        status: 'scheduled',
        publishAt: { $lte: now }
      },
      {
        $set: {
          status: 'published',
          publishedAt: now,
          date: now // Update the sort date to make it appear fresh
        }
      }
    );

    if (publishResult.modifiedCount > 0) {
      console.log(`[Scheduler] Auto-published ${publishResult.modifiedCount} scheduled notice(s).`);
    }

    // 2. Archive expired notices in one query using updateMany
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
      console.log(`[Scheduler] Auto-archived ${archiveResult.modifiedCount} expired notice(s).`);
    }
  } catch (error) {
    console.error('[Scheduler] Error running notice cron job:', error);
  }
};

cron.schedule('* * * * *', checkAndProcessNotices);

console.log('[Scheduler] Notice background scheduler initialized.');

module.exports = { checkAndProcessNotices };
