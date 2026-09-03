import { ObjectId } from 'mongodb';

export type SeedPostMediaType = 'image' | 'video' | 'reel' | 'carousel' | 'unknown';
export type SeedPostStatus = 'active' | 'archived';
export type SeedPostLane = 'fresh' | 'hot' | null;

/**
 * Centralized evaluation thresholds for E2 HOT Lane.
 * Kept in one place to easily migrate to PlatformSettings later.
 */
export const SEED_POST_HOT_THRESHOLDS = {
  MIN_NEW_COMMENTS: 50,
  MIN_GROWTH_PERCENT: 50,
} as const;

export interface SeedPost {
  _id?: ObjectId;
  shortcode: string;
  postUrl: string;
  instagramPostId?: string;
  mediaType: SeedPostMediaType;
  caption?: string;
  postedAt?: Date;

  // Seed relation
  seedAccountId: ObjectId;
  seedUsername: string;

  // Engagement
  currentCommentCount: number;
  lastScannedCommentCount: number;
  scanCount: number;

  // Tracking
  firstSeenAt: Date;
  lastCheckedAt: Date;
  lastScrapedAt?: Date;

  // Override / state
  manuallyHot: boolean;
  status: SeedPostStatus;

  createdAt: Date;
  updatedAt: Date;
}

export interface SeedPostMetadataInput {
  seedAccountId: string;
  seedUsername: string;
  shortcode: string;
  postUrl?: string;
  instagramPostId?: string;
  mediaType?: SeedPostMediaType;
  caption?: string;
  postedAt?: string | Date;
  currentCommentCount: number;
}

export interface EvaluateSeedPostsBatchInput {
  posts: SeedPostMetadataInput[];
}

export interface EvaluatedPostResult {
  seedPostId: string;
  shortcode: string;
  postUrl: string;
  seedAccountId: string;
  seedUsername: string;
  lane: SeedPostLane;
  shouldScrape: boolean;
  currentCommentCount: number;
  lastScannedCommentCount: number;
  absoluteCommentGrowth: number;
  relativeCommentGrowthPercent: number;
}

export interface BatchEvaluationResponse {
  totalEvaluated: number;
  qualifiedCount: number;
  freshCount: number;
  hotCount: number;
  results: EvaluatedPostResult[];
}

export interface MarkSeedPostScrapedInput {
  scannedCommentCount?: number;
}
