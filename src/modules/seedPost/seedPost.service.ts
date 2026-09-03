import { ObjectId } from 'mongodb';
import { getDB } from '../../config/db';
import {
  SeedPost,
  SeedPostMetadataInput,
  EvaluatedPostResult,
  BatchEvaluationResponse,
  MarkSeedPostScrapedInput,
  SEED_POST_HOT_THRESHOLDS,
} from './seedPost.types';

const getCollection = () => getDB().collection<SeedPost>('seedPosts');

const parseValidDate = (dateVal?: string | Date): Date | undefined => {
  if (!dateVal) return undefined;
  const parsed = dateVal instanceof Date ? dateVal : new Date(dateVal);
  return isNaN(parsed.getTime()) ? undefined : parsed;
};

/**
 * Helper to resolve a seed post by its MongoDB ObjectId or Instagram shortcode.
 */
export const findSeedPostByIdOrShortcode = async (
  idOrShortcode: string
): Promise<SeedPost | null> => {
  const collection = getCollection();
  const trimmed = idOrShortcode.trim();

  if (ObjectId.isValid(trimmed)) {
    const postById = await collection.findOne({ _id: new ObjectId(trimmed) });
    if (postById) return postById;
  }

  return await collection.findOne({ shortcode: trimmed });
};

/**
 * Evaluates a batch of recent Instagram post metadata from verified seed accounts.
 * Classifies each post into E1 FRESH or E2 HOT lane, updating DB state idempotently.
 */
export const evaluateAndSyncSeedPosts = async (
  posts: SeedPostMetadataInput[]
): Promise<BatchEvaluationResponse> => {
  const collection = getCollection();
  const results: EvaluatedPostResult[] = [];

  let freshCount = 0;
  let hotCount = 0;

  for (const postInput of posts) {
    const shortcode = postInput.shortcode?.trim();
    const rawSeedAccountId = postInput.seedAccountId?.trim();

    if (!shortcode || !rawSeedAccountId || !ObjectId.isValid(rawSeedAccountId)) {
      continue;
    }

    const seedAccountId = new ObjectId(rawSeedAccountId);
    const incomingCount = Math.max(
      0,
      Math.floor(Number(postInput.currentCommentCount) || 0)
    );
    const now = new Date();

    const existing = await collection.findOne({ shortcode });

    if (!existing) {
      const validPostedAt = parseValidDate(postInput.postedAt);
      const newPost: SeedPost = {
        shortcode,
        postUrl:
          postInput.postUrl?.trim() ||
          `https://www.instagram.com/p/${shortcode}/`,
        instagramPostId: postInput.instagramPostId?.trim(),
        mediaType: postInput.mediaType || 'unknown',
        caption: postInput.caption?.trim(),
        ...(validPostedAt ? { postedAt: validPostedAt } : {}),
        seedAccountId,
        seedUsername: (postInput.seedUsername || '').toLowerCase().trim(),
        currentCommentCount: incomingCount,
        lastScannedCommentCount: 0,
        scanCount: 0,
        firstSeenAt: now,
        lastCheckedAt: now,
        manuallyHot: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };

      const insertRes = await collection.insertOne(newPost);
      freshCount++;

      results.push({
        seedPostId: insertRes.insertedId.toString(),
        shortcode: newPost.shortcode,
        postUrl: newPost.postUrl,
        seedAccountId: newPost.seedAccountId.toString(),
        seedUsername: newPost.seedUsername,
        lane: 'fresh',
        shouldScrape: true,
        currentCommentCount: incomingCount,
        lastScannedCommentCount: 0,
        absoluteCommentGrowth: incomingCount,
        relativeCommentGrowthPercent: 100,
      });
    } else if (existing.status === 'archived') {
      // -------------------------------------------------------------
      // ARCHIVED: Do not scrape and do not treat as HOT
      // -------------------------------------------------------------
      const baseline = Math.max(0, existing.lastScannedCommentCount || 0);
      results.push({
        seedPostId: existing._id!.toString(),
        shortcode: existing.shortcode,
        postUrl: existing.postUrl,
        seedAccountId: existing.seedAccountId.toString(),
        seedUsername: existing.seedUsername,
        lane: null,
        shouldScrape: false,
        currentCommentCount: incomingCount,
        lastScannedCommentCount: baseline,
        absoluteCommentGrowth: Math.max(0, incomingCount - baseline),
        relativeCommentGrowthPercent: 0,
      });
    } else if (existing.scanCount === 0) {
      // -------------------------------------------------------------
      // E1 FRESH: Previously discovered but never scraped yet -> Still FRESH
      // -------------------------------------------------------------
      const updateDoc: Partial<SeedPost> = {
        currentCommentCount: incomingCount,
        lastCheckedAt: now,
        updatedAt: now,
      };

      if (postInput.caption !== undefined) updateDoc.caption = postInput.caption.trim();
      if (postInput.mediaType !== undefined) updateDoc.mediaType = postInput.mediaType;
      if (postInput.postedAt !== undefined) {
        const validPostedAt = parseValidDate(postInput.postedAt);
        if (validPostedAt) updateDoc.postedAt = validPostedAt;
      }

      await collection.updateOne({ _id: existing._id }, { $set: updateDoc });
      freshCount++;

      results.push({
        seedPostId: existing._id!.toString(),
        shortcode: existing.shortcode,
        postUrl: existing.postUrl,
        seedAccountId: existing.seedAccountId.toString(),
        seedUsername: existing.seedUsername,
        lane: 'fresh',
        shouldScrape: true,
        currentCommentCount: incomingCount,
        lastScannedCommentCount: 0,
        absoluteCommentGrowth: incomingCount,
        relativeCommentGrowthPercent: 100,
      });
    } else {
      // -------------------------------------------------------------
      // E2 HOT: Previously scraped (scanCount > 0) -> Evaluate Growth
      // -------------------------------------------------------------
      const baseline = Math.max(0, existing.lastScannedCommentCount || 0);
      const absoluteGrowth = Math.max(0, incomingCount - baseline);
      const relativeGrowthPercent =
        baseline > 0
          ? (absoluteGrowth / baseline) * 100
          : incomingCount >= SEED_POST_HOT_THRESHOLDS.MIN_NEW_COMMENTS
          ? 100
          : 0;

      const isHot =
        existing.manuallyHot === true ||
        absoluteGrowth >= SEED_POST_HOT_THRESHOLDS.MIN_NEW_COMMENTS ||
        relativeGrowthPercent >= SEED_POST_HOT_THRESHOLDS.MIN_GROWTH_PERCENT;

      const updateDoc: Partial<SeedPost> = {
        currentCommentCount: incomingCount,
        lastCheckedAt: now,
        updatedAt: now,
      };

      if (postInput.caption !== undefined) updateDoc.caption = postInput.caption.trim();
      if (postInput.mediaType !== undefined) updateDoc.mediaType = postInput.mediaType;

      await collection.updateOne({ _id: existing._id }, { $set: updateDoc });

      if (isHot) {
        hotCount++;
      }

      results.push({
        seedPostId: existing._id!.toString(),
        shortcode: existing.shortcode,
        postUrl: existing.postUrl,
        seedAccountId: existing.seedAccountId.toString(),
        seedUsername: existing.seedUsername,
        lane: isHot ? 'hot' : null,
        shouldScrape: isHot,
        currentCommentCount: incomingCount,
        lastScannedCommentCount: baseline,
        absoluteCommentGrowth: absoluteGrowth,
        relativeCommentGrowthPercent: Math.round(relativeGrowthPercent * 100) / 100,
      });
    }
  }

  return {
    totalEvaluated: results.length,
    qualifiedCount: freshCount + hotCount,
    freshCount,
    hotCount,
    results,
  };
};

/**
 * Marks a post's comments as having been scraped for leads.
 * Updates lastScannedCommentCount, increments scanCount, and sets lastScrapedAt.
 */
export const markSeedPostScraped = async (
  idOrShortcode: string,
  input?: MarkSeedPostScrapedInput
): Promise<SeedPost> => {
  const collection = getCollection();
  const post = await findSeedPostByIdOrShortcode(idOrShortcode);

  if (!post) {
    throw new Error(`Seed post not found: ${idOrShortcode}`);
  }

  const now = new Date();
  const commentCountToRecord =
    input?.scannedCommentCount !== undefined
      ? Math.max(0, Math.floor(Number(input.scannedCommentCount) || 0))
      : post.currentCommentCount;

  await collection.updateOne(
    { _id: post._id },
    {
      $set: {
        lastScannedCommentCount: commentCountToRecord,
        lastScrapedAt: now,
        updatedAt: now,
      },
      $inc: {
        scanCount: 1,
      },
    }
  );

  const updated = await collection.findOne({ _id: post._id });
  return updated!;
};
