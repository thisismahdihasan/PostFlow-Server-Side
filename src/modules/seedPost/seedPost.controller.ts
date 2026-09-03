import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import * as seedPostService from './seedPost.service';

/**
 * INTERNAL API: Ingest and evaluate a batch of seed post metadata.
 * Classifies posts into FRESH or HOT lane.
 */
export const evaluateBatch = catchAsync(async (req: Request, res: Response) => {
  const { posts } = req.body;

  if (!Array.isArray(posts)) {
    return res.status(400).json({
      message: 'Invalid payload: posts array is required',
    });
  }

  const result = await seedPostService.evaluateAndSyncSeedPosts(posts);
  return res.status(200).json(result);
});

/**
 * INTERNAL API: Mark a seed post as having its comments scraped for leads.
 * Updates lastScannedCommentCount, increments scanCount, and sets lastScrapedAt.
 */
export const markScraped = catchAsync(async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';

  if (!id) {
    return res.status(400).json({
      message: 'Post ID or shortcode parameter is required',
    });
  }

  try {
    const updatedPost = await seedPostService.markSeedPostScraped(id, req.body);
    return res.status(200).json(updatedPost);
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return res.status(404).json({ message: err.message });
    }
    throw err;
  }
});
