import { MongoClient, ServerApiVersion, Db } from 'mongodb';
import { env } from './env';

const uri = env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db: Db;
let initDbPromise: Promise<Db> | null = null;

const initialAccounts = [
  {
    slug: 'snortpugs',
    displayName: 'Snortpugs',
    driveFolderName: 'Snortpugs',
    platform: 'instagram',
    isActive: true,
    order: 1,
  },
  {
    slug: 'pugsnortz',
    displayName: 'Pugsnortz',
    driveFolderName: 'Pugsnortz',
    platform: 'instagram',
    isActive: true,
    order: 2,
  },
  {
    slug: 'pugsnuff',
    displayName: 'Pugsnuff',
    driveFolderName: 'Pugsnuff',
    platform: 'instagram',
    isActive: true,
    order: 3,
  },
];

export const initializeDatabase = async (): Promise<Db> => {
  if (initDbPromise) {
    return initDbPromise;
  }

  initDbPromise = (async () => {
    try {
      db = client.db('postFlow-db');
      
      // Posts Indexes
      await db.collection('posts').createIndex(
        { account: 1, scheduledDate: 1, 'media.fingerprint': 1 },
        { 
          unique: true, 
          partialFilterExpression: { 
            account: { $type: 'string' },
            scheduledDate: { $type: 'string' },
            'media.fingerprint': { $type: 'string' }
          } 
        }
      );
      await db.collection('posts').createIndex({ account: 1, scheduledDate: 1, createdAt: -1 });

      // Users Indexes
      await db.collection('users').createIndex({ firebaseUid: 1 }, { unique: true });
      await db.collection('users').createIndex({ status: 1, createdAt: -1 });

      // Accounts Indexes
      await db.collection('accounts').createIndex({ slug: 1 }, { unique: true });
      await db.collection('accounts').createIndex({ order: 1 });

      // SyncRuns Indexes
      await db.collection('syncRuns').createIndex({ createdAt: 1 });
      await db.collection('syncRuns').createIndex({ status: 1 });
      await db.collection('syncRuns').createIndex({ targetDate: 1 });
      await db.collection('syncRuns').createIndex({ targetDate: 1, status: 1, triggeredBy: 1 });
      await db.collection('syncRuns').createIndex({ retryOf: 1, createdAt: -1 });
      await db.collection('syncRuns').createIndex(
        { lockKey: 1 },
        {
          unique: true,
          partialFilterExpression: {
            status: 'running',
            lockKey: 'global-sync',
          },
        }
      );

      // AutomationJobs Indexes (Platform-wide Heavy Lock & Priority Queue)
      await db.collection('automationJobs').createIndex({ createdAt: 1 });
      await db.collection('automationJobs').createIndex({ status: 1 });
      await db.collection('automationJobs').createIndex({ targetDate: 1 });
      await db.collection('automationJobs').createIndex({ referenceId: 1 });
      await db.collection('automationJobs').createIndex({ status: 1, priority: -1, createdAt: 1 });
      await db.collection('automationJobs').createIndex(
        { lockKey: 1 },
        {
          unique: true,
          partialFilterExpression: {
            status: 'running',
            lockKey: 'global-heavy-lock',
          },
        }
      );
      await db.collection('automationJobs').createIndex(
        { jobType: 1, targetDate: 1 },
        {
          unique: true,
          partialFilterExpression: {
            jobType: 'LEAD_AUTO',
            status: { $in: ['pending', 'running'] },
          },
        }
      );
      await db.collection('automationJobs').createIndex(
        { jobType: 1, targetDate: 1, priority: 1 },
        {
          unique: true,
          partialFilterExpression: {
            jobType: 'POST_SYNC',
            priority: 30,
            status: { $in: ['pending', 'running'] },
          },
        }
      );

      // DriveAutomationRuns Indexes
      await db.collection('driveAutomationRuns').createIndex({ createdAt: -1 });
      await db.collection('driveAutomationRuns').createIndex({ n8nExecutionId: 1 });

      // Hashtag Collections Indexes
      await db.collection('hashtagGroups').createIndex({ account: 1, order: 1 });
      await db.collection('hashtagRotations').createIndex({ account: 1 }, { unique: true });

      // LeadAssignments Indexes (B3/B4 Quota & Release Control)
      await db.collection('leadAssignments').createIndex({ targetAccountId: 1, assignedDate: 1 });
      await db.collection('leadAssignments').createIndex({ targetAccountId: 1, assignedDate: 1, isReserve: 1 });
      await db.collection('leadAssignments').createIndex({ targetAccountId: 1, assignedDate: 1, availableAt: 1, isReserve: 1 });
      await db.collection('leadAssignments').createIndex({ status: 1, availableAt: 1 });
      await db.collection('leadAssignments').createIndex(
        { targetAccountId: 1, candidateId: 1, assignedDate: 1 },
        {
          unique: true,
          partialFilterExpression: {
            targetAccountId: { $exists: true },
            candidateId: { $type: 'string' },
            assignedDate: { $type: 'string' },
          },
        }
      );

      // SeedAccounts Indexes (C1 Manual Seed Management)
      await db.collection('seedAccounts').createIndex({ username: 1 }, { unique: true });
      await db.collection('seedAccounts').createIndex({ status: 1, enabled: 1 });
      await db.collection('seedAccounts').createIndex({ createdAt: -1 });

      // SeedPosts Indexes (Phase E: Seed Post Discovery)
      await db.collection('seedPosts').createIndex({ shortcode: 1 }, { unique: true });
      await db.collection('seedPosts').createIndex({ seedAccountId: 1, postedAt: -1 });
      await db.collection('seedPosts').createIndex({ status: 1 });

      // Idempotent Seed
      const accountsCollection = db.collection('accounts');
      for (const acc of initialAccounts) {
        await accountsCollection.updateOne(
          { slug: acc.slug },
          { $setOnInsert: { ...acc, createdAt: new Date(), updatedAt: new Date() } },
          { upsert: true }
        );
      }
      
      return db;
    } catch (error) {
      console.error('Error initializing MongoDB:', error);
      initDbPromise = null; // allow retry on next request if it failed
      throw error;
    }
  })();

  return initDbPromise;
};

export const getDB = () => {
  if (!db) {
    db = client.db('postFlow-db');
  }
  return db;
};
