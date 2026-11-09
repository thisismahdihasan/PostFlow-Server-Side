import { ObjectId } from 'mongodb';
import { getDB } from '../../config/db';
import { getPlatformSettings } from '../platformSettings/platformSettings.service';
import { DEFAULT_ACCOUNT_LEAD_FINDER, Account } from '../account/account.types';
import {
  LeadAssignment,
  LeadQuotaSummary,
  AssignCandidateInput,
  AccountDemandItem,
  DailyDemandSummary,
} from './lead.types';
import {
  calculateGenerationTarget,
  calculateReleaseBatches,
  calculateQuotaNeeds,
  computeLeadSlot,
} from './lead.helper';
import { getCurrentDateInTimezone } from '../../utils/timezone.helper';

const getCollection = () => getDB().collection<LeadAssignment>('leadAssignments');

/**
 * Resolve target account dynamically by ObjectId or unique slug.
 */
export const resolveAccount = async (accountIdOrSlug: string): Promise<Account | null> => {
  const db = getDB();
  const accountsCollection = db.collection<Account>('accounts');

  if (ObjectId.isValid(accountIdOrSlug)) {
    const byId = await accountsCollection.findOne({ _id: new ObjectId(accountIdOrSlug) });
    if (byId) return byId;
  }

  return await accountsCollection.findOne({ slug: accountIdOrSlug });
};

/**
 * Calculate the quota, needs, and release schedule for a given account and date.
 * Fully dynamic — accounts and global settings are fetched from DB.
 */
export const getDailyLeadQuotaSummary = async (
  accountIdOrSlug: string,
  assignedDate: string,
  options?: { anchorTime?: Date }
): Promise<LeadQuotaSummary> => {
  const account = await resolveAccount(accountIdOrSlug);
  if (!account) {
    throw new Error(`Account not found: ${accountIdOrSlug}`);
  }

  const platformSettings = await getPlatformSettings();
  const bufferPercent = platformSettings.leadFinder?.leadBufferPercent ?? 0;

  const accountLf = {
    ...DEFAULT_ACCOUNT_LEAD_FINDER,
    ...(account.leadFinder || {}),
  };

  const collection = getCollection();
  const targetAccountId = account._id!;

  // Count assigned normal leads (isReserve !== true)
  const assignedNormalCount = await collection.countDocuments({
    targetAccountId,
    assignedDate,
    isReserve: { $ne: true },
  });

  // Count assigned reserve leads (isReserve === true)
  const reserveCount = await collection.countDocuments({
    targetAccountId,
    assignedDate,
    isReserve: true,
  });

  const quota = calculateQuotaNeeds({
    dailyLeadTarget: accountLf.dailyLeadTarget,
    leadBufferPercent: bufferPercent,
    assignedNormalCount,
    reserveCount,
  });

  // Calculate release batch times using anchorTime (or first batch time from DB if exists, or now)
  let anchorTime = options?.anchorTime;
  if (!anchorTime) {
    const firstAssigned = await collection.findOne(
      { targetAccountId, assignedDate, isReserve: { $ne: true }, availableAt: { $exists: true } },
      { sort: { availableAt: 1 } }
    );
    anchorTime = firstAssigned?.availableAt || new Date();
  }

  const releaseBatches = calculateReleaseBatches(
    accountLf.dailyLeadTarget,
    accountLf.releaseBatchSize,
    accountLf.releaseIntervalMinutes,
    anchorTime
  );

  return {
    targetAccountId: targetAccountId.toString(),
    accountSlug: account.slug,
    assignedDate,
    visibleTarget: quota.visibleTarget,
    bufferPercent,
    generationTarget: quota.generationTarget,
    assignedNormalCount: quota.assignedNormalCount,
    reserveCount: quota.reserveCount,
    totalAssignedCount: quota.totalAssignedCount,
    remainingNormalNeed: quota.remainingNormalNeed,
    remainingGenerationNeed: quota.remainingGenerationNeed,
    releaseBatches,
  };
};

/**
 * Worker-facing leads query:
 * CRITICAL: Backend enforces that ONLY normal leads where availableAt <= currentTime are returned.
 * Future locked leads (availableAt > now) and Reserve leads (isReserve: true) are EXCLUDED at query level.
 */
export const getWorkerVisibleLeads = async (
  accountIdOrSlug: string,
  assignedDate: string,
  currentTime: Date = new Date()
): Promise<LeadAssignment[]> => {
  const account = await resolveAccount(accountIdOrSlug);
  if (!account) {
    throw new Error(`Account not found: ${accountIdOrSlug}`);
  }

  const collection = getCollection();

  return await collection
    .find({
      targetAccountId: account._id!,
      assignedDate,
      status: 'pending',
      isReserve: { $ne: true }, // NEVER return reserve leads
      availableAt: { $lte: currentTime }, // ONLY availableAt <= currentTime
    })
    .sort({ availableAt: 1, batchIndex: 1, createdAt: 1 })
    .toArray();
};

/** Process one released assignment without changing its quota or release slot. */
export const updateWorkerLeadStatus = async (params: {
  assignmentId: string;
  accountIdOrSlug: string;
  assignedDate: string;
  status: 'followed' | 'skipped';
}): Promise<LeadAssignment> => {
  const account = await resolveAccount(params.accountIdOrSlug);
  if (!account) {
    throw Object.assign(new Error(`Account not found: ${params.accountIdOrSlug}`), { statusCode: 404 });
  }

  const now = new Date();
  const collection = getCollection();
  const eligibleAssignment = {
    _id: new ObjectId(params.assignmentId),
    targetAccountId: account._id!,
    assignedDate: params.assignedDate,
    isReserve: { $ne: true },
    availableAt: { $lte: now },
  };

  const updated = await collection.findOneAndUpdate(
    { ...eligibleAssignment, status: 'pending' },
    { $set: { status: params.status, updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (updated) return updated;

  // The same guards prevent retry handling from exposing locked or unrelated leads.
  const existing = await collection.findOne(eligibleAssignment);
  if (!existing) {
    throw Object.assign(new Error('Lead assignment not found or unavailable'), { statusCode: 404 });
  }
  if (existing.status === params.status) return existing;

  throw Object.assign(new Error('Lead assignment status conflicts with the requested action'), { statusCode: 409 });
};

/**
 * Assign new qualified lead candidates for an account/date.
 * Automatically slots leads into release batches (up to dailyLeadTarget)
 * and marks additional leads (up to generationTarget) as reserve.
 */
export const assignLeadCandidates = async (params: {
  accountIdOrSlug: string;
  assignedDate: string;
  candidates: AssignCandidateInput[];
  anchorTime?: Date;
}): Promise<{
  insertedCount: number;
  assigned: LeadAssignment[];
  quotaSummary: LeadQuotaSummary;
}> => {
  const account = await resolveAccount(params.accountIdOrSlug);
  if (!account) {
    throw new Error(`Account not found: ${params.accountIdOrSlug}`);
  }

  const targetAccountId = account._id!;
  const assignedDate = params.assignedDate;
  const collection = getCollection();

  const accountLf = {
    ...DEFAULT_ACCOUNT_LEAD_FINDER,
    ...(account.leadFinder || {}),
  };

  const platformSettings = await getPlatformSettings();
  const bufferPercent = platformSettings.leadFinder?.leadBufferPercent ?? 0;
  const generationTarget = calculateGenerationTarget(accountLf.dailyLeadTarget, bufferPercent);

  // Existing counts
  let existingNormalCount = await collection.countDocuments({
    targetAccountId,
    assignedDate,
    isReserve: { $ne: true },
  });

  let existingReserveCount = await collection.countDocuments({
    targetAccountId,
    assignedDate,
    isReserve: true,
  });

  // Anchor time for release scheduling
  let anchorTime = params.anchorTime;
  if (!anchorTime) {
    const firstAssigned = await collection.findOne(
      { targetAccountId, assignedDate, isReserve: { $ne: true }, availableAt: { $exists: true } },
      { sort: { availableAt: 1 } }
    );
    anchorTime = firstAssigned?.availableAt || new Date();
  }

  const now = new Date();
  const assignmentsToInsert: LeadAssignment[] = [];
  const existingAssignments = await collection
    .find({ targetAccountId, assignedDate }, { projection: { candidateId: 1, _id: 0 } })
    .toArray();
  const assignedCandidateIds = new Set(existingAssignments.map((assignment) => assignment.candidateId));

  for (const candidate of params.candidates) {
    // Skip existing and request-local duplicates before allocating any quota slot.
    if (assignedCandidateIds.has(candidate.candidateId)) {
      continue;
    }

    // If we've already filled generationTarget, stop assigning extra leads
    const currentTotal = existingNormalCount + existingReserveCount;
    if (currentTotal >= generationTarget) {
      break;
    }

    const slot = computeLeadSlot(
      existingNormalCount,
      accountLf.dailyLeadTarget,
      accountLf.releaseBatchSize,
      accountLf.releaseIntervalMinutes,
      anchorTime
    );

    const doc: LeadAssignment = {
      candidateId: candidate.candidateId,
      candidateUsername: candidate.candidateUsername,
      targetAccountId,
      accountSlug: account.slug,
      assignedDate,
      status: 'pending',
      isReserve: slot.isReserve,
      batchIndex: slot.batchIndex,
      availableAt: slot.availableAt,
      source: candidate.source || 'auto',
      metadata: candidate.metadata,
      createdAt: now,
      updatedAt: now,
    };

    assignmentsToInsert.push(doc);
    assignedCandidateIds.add(candidate.candidateId);

    if (slot.isReserve) {
      existingReserveCount++;
    } else {
      existingNormalCount++;
    }
  }

  let insertedAssignments: LeadAssignment[] = [];
  if (assignmentsToInsert.length > 0) {
    const result = await collection.insertMany(assignmentsToInsert);
    insertedAssignments = assignmentsToInsert.map((item, idx) => ({
      ...item,
      _id: result.insertedIds[idx],
    }));
  }

  const quotaSummary = await getDailyLeadQuotaSummary(account.slug, assignedDate, { anchorTime });

  return {
    insertedCount: insertedAssignments.length,
    assigned: insertedAssignments,
    quotaSummary,
  };
};

/**
 * Admin helper to retrieve all assignments for a target account and date (including future & reserve).
 */
export const getAllLeadAssignmentsForDate = async (
  accountIdOrSlug: string,
  assignedDate: string
): Promise<LeadAssignment[]> => {
  const account = await resolveAccount(accountIdOrSlug);
  if (!account) {
    throw new Error(`Account not found: ${accountIdOrSlug}`);
  }

  return await getCollection()
    .find({
      targetAccountId: account._id!,
      assignedDate,
    })
    .sort({ isReserve: 1, batchIndex: 1, createdAt: 1 })
    .toArray();
};

/**
 * Calculate the daily lead generation demand across all active & eligible target accounts.
 * If targetDate is not supplied, resolves the business date using platformSettings.leadFinder.timezone.
 */
export const getDailyDemandSummary = async (
  targetDate?: string
): Promise<DailyDemandSummary> => {
  const platformSettings = await getPlatformSettings();
  const timezone = platformSettings.leadFinder?.timezone?.trim() || 'Asia/Dhaka';

  const resolvedDate = targetDate && targetDate.trim()
    ? targetDate.trim()
    : getCurrentDateInTimezone(timezone);

  const db = getDB();
  const accountsCollection = db.collection<Account>('accounts');

  // Find all eligible target accounts where isActive is true and leadFinder.enabled is true
  const eligibleAccounts = await accountsCollection
    .find({
      platform: 'instagram',
      isActive: true,
      'leadFinder.enabled': true,
    })
    .sort({ order: 1, createdAt: 1 })
    .toArray();

  const accountDemandItems: AccountDemandItem[] = [];

  for (const account of eligibleAccounts) {
    const quota = await getDailyLeadQuotaSummary(account._id!.toString(), resolvedDate);

    accountDemandItems.push({
      targetAccountId: quota.targetAccountId,
      accountSlug: quota.accountSlug,
      displayName: account.displayName,
      targetDate: resolvedDate,
      dailyLeadTarget: quota.visibleTarget,
      alreadyAssignedQualified: quota.assignedNormalCount,
      remainingRequired: quota.remainingNormalNeed,
      bufferPercent: quota.bufferPercent,
      generationTarget: quota.generationTarget,
      remainingGenerationNeed: quota.remainingGenerationNeed,
      shouldScrape: quota.remainingGenerationNeed > 0,
    });
  }

  return {
    targetDate: resolvedDate,
    timezone,
    accounts: accountDemandItems,
  };
};
