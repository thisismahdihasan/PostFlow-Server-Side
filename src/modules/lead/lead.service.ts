import { Filter, ObjectId } from 'mongodb';
import { getDB } from '../../config/db';
import { getPlatformSettings } from '../platformSettings/platformSettings.service';
import { DEFAULT_ACCOUNT_LEAD_FINDER, Account } from '../account/account.types';
import { LeadCandidate } from '../leadCandidate/leadCandidate.types';
import {
  LeadAssignment,
  WorkerVisibleLead,
  LeadQuotaSummary,
  AssignCandidateInput,
  AccountDemandItem,
  DailyDemandSummary,
  ProcessingActivityCounts,
  AssignmentCohortCounts,
  LeadAssignmentStatus,
} from './lead.types';
import {
  calculateGenerationTarget,
  calculateReleaseBatches,
  calculateQuotaNeeds,
  computeLeadSlot,
} from './lead.helper';
import { getCurrentDateInTimezone, getDateRangeInTimezone, isValidIanaTimezone } from '../../utils/timezone.helper';

const getCollection = () => getDB().collection<LeadAssignment>('leadAssignments');

const getActivityTimezone = async (): Promise<string> => {
  const settings = await getPlatformSettings();
  const timezone = settings.leadFinder?.timezone?.trim() || 'Asia/Dhaka';
  return isValidIanaTimezone(timezone) ? timezone : 'Asia/Dhaka';
};

const getProcessingActivity = async (filter: Filter<LeadAssignment>): Promise<ProcessingActivityCounts> => {
  const counts = await getCollection().aggregate<{ _id: 'followed' | 'skipped'; count: number }>([
    { $match: { ...filter, status: { $in: ['followed', 'skipped'] } } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).toArray();
  const followed = counts.find((row) => row._id === 'followed')?.count || 0;
  const skipped = counts.find((row) => row._id === 'skipped')?.count || 0;
  return { followed, skipped, completed: followed + skipped };
};

export const getMyLeadActivity = async (firebaseUid: string, now: Date = new Date()) => {
  const timezone = await getActivityTimezone();
  const today = getCurrentDateInTimezone(timezone, now);
  const previousDate = new Date(`${today}T00:00:00.000Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const yesterday = previousDate.toISOString().slice(0, 10);
  const todayRange = getDateRangeInTimezone(today, timezone);
  const yesterdayRange = getDateRangeInTimezone(yesterday, timezone);
  const [todayActivity, yesterdayActivity] = await Promise.all([
    getProcessingActivity({ processedByFirebaseUid: firebaseUid, processedAt: { $gte: todayRange.start, $lt: todayRange.end } }),
    getProcessingActivity({ processedByFirebaseUid: firebaseUid, processedAt: { $gte: yesterdayRange.start, $lt: yesterdayRange.end } }),
  ]);
  return {
    timezone,
    today: { date: today, ...todayActivity },
    yesterday: { date: yesterday, ...yesterdayActivity },
  };
};

export const getMyLeadActivityRange = async (firebaseUid: string, from: string, to: string, accountIdOrSlug?: string) => {
  const account = accountIdOrSlug !== undefined ? await resolveAccount(accountIdOrSlug) : null;
  if (accountIdOrSlug !== undefined && !account) {
    throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  }
  const timezone = await getActivityTimezone();
  const { start } = getDateRangeInTimezone(from, timezone);
  const { end } = getDateRangeInTimezone(to, timezone);
  const { followed, skipped } = await getProcessingActivity({
    processedByFirebaseUid: firebaseUid,
    ...(account ? { targetAccountId: account._id } : {}),
    processedAt: { $gte: start, $lt: end },
    isReserve: { $ne: true },
  });
  return { ...(account ? { account: account.slug } : {}), timezone, from, to, followed, skipped };
};

export const getLeadActivitySummary = async (accountIdOrSlug: string, date: string) => {
  const account = await resolveAccount(accountIdOrSlug);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  const timezone = await getActivityTimezone();
  const range = getDateRangeInTimezone(date, timezone);
  const [cohortRows, processingActivity] = await Promise.all([
    getCollection().aggregate<{ _id: { status: LeadAssignmentStatus; reserve: boolean }; count: number }>([
      { $match: { targetAccountId: account._id!, assignedDate: date } },
      { $group: { _id: { status: '$status', reserve: { $eq: ['$isReserve', true] } }, count: { $sum: 1 } } },
    ]).toArray(),
    getProcessingActivity({ targetAccountId: account._id!, processedAt: { $gte: range.start, $lt: range.end } }),
  ]);
  const normal: AssignmentCohortCounts = { assigned: 0, pending: 0, followed: 0, skipped: 0, rejected: 0 };
  const reserve: AssignmentCohortCounts = { ...normal };
  for (const row of cohortRows) {
    const counts = row._id.reserve ? reserve : normal;
    counts.assigned += row.count;
    if (row._id.status === 'pending' || row._id.status === 'followed'
      || row._id.status === 'skipped' || row._id.status === 'rejected') {
      counts[row._id.status] += row.count;
    }
  }
  return {
    account: account.slug,
    date,
    timezone,
    // Current statuses, including locked assignments; not an availability count or daily snapshot.
    assignmentCohort: { normal, reserve },
    processingActivity,
  };
};

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
  assignedDate?: string,
  page: number = 1,
  limit: number = 10,
  currentTime: Date = new Date()
): Promise<{ leads: WorkerVisibleLead[]; totalCount: number }> => {
  const account = await resolveAccount(accountIdOrSlug);
  if (!account) {
    throw new Error(`Account not found: ${accountIdOrSlug}`);
  }

  const collection = getCollection();
  let dateFilter: string | { $lte: string };
  if (assignedDate !== undefined) {
    dateFilter = assignedDate;
  } else {
    const settings = await getPlatformSettings();
    const timezone = settings.leadFinder?.timezone?.trim() || 'Asia/Dhaka';
    dateFilter = { $lte: getCurrentDateInTimezone(timezone, currentTime) };
  }

  const filter: Filter<LeadAssignment> = {
    targetAccountId: account._id!,
    assignedDate: dateFilter,
    status: 'pending',
    isReserve: { $ne: true }, // NEVER return reserve leads
    availableAt: { $lte: currentTime }, // ONLY availableAt <= currentTime
  };
  const [assignments, totalCount] = await Promise.all([
    collection.find(filter)
      .sort(assignedDate === undefined
        ? { assignedDate: 1, availableAt: 1, createdAt: 1, _id: 1 }
        : { availableAt: 1, batchIndex: 1, createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    collection.countDocuments(filter),
  ]);

  const candidateIds = new Map<string, ObjectId>();
  for (const assignment of assignments) {
    if (typeof assignment.candidateId === 'string' && ObjectId.isValid(assignment.candidateId)) {
      const id = new ObjectId(assignment.candidateId);
      candidateIds.set(id.toHexString(), id);
    }
  }
  if (candidateIds.size === 0) return { leads: assignments, totalCount };

  const candidates = await getDB().collection<LeadCandidate>('leadCandidates')
    .find(
      { _id: { $in: [...candidateIds.values()] } },
      { projection: { _id: 1, profilePicUrl: 1 } }
    )
    .toArray();
  const images = new Map(candidates.map((candidate) => [candidate._id.toHexString(), candidate.profilePicUrl]));

  const leads = assignments.map((assignment) => {
    const profilePicUrl = typeof assignment.candidateId === 'string'
      ? images.get(assignment.candidateId.toLowerCase())
      : undefined;
    return typeof profilePicUrl === 'string' && profilePicUrl.trim()
      ? { ...assignment, profilePicUrl }
      : assignment;
  });
  return { leads, totalCount };
};

/** Process one released assignment without changing its quota or release slot. */
export const updateWorkerLeadStatus = async (params: {
  assignmentId: string;
  accountIdOrSlug: string;
  assignedDate: string;
  status: 'followed' | 'skipped';
  processedByFirebaseUid: string;
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
    { $set: {
      status: params.status,
      processedByFirebaseUid: params.processedByFirebaseUid,
      processedAt: now,
      updatedAt: now,
    } },
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

  if (account.isActive !== true) {
    throw Object.assign(new Error('Account is inactive'), { statusCode: 409 });
  }

  const accountLf = {
    ...DEFAULT_ACCOUNT_LEAD_FINDER,
    ...(account.leadFinder || {}),
  };

  if (accountLf.enabled !== true) {
    throw Object.assign(new Error('Lead Finder is disabled for this account'), { statusCode: 409 });
  }

  const targetAccountId = account._id!;
  const assignedDate = params.assignedDate;
  const collection = getCollection();

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
  const submittedCandidateIds = [...new Set(params.candidates.map((candidate) => candidate.candidateId))];
  const existingAssignments = await collection
    .find({ targetAccountId, candidateId: { $in: submittedCandidateIds } }, { projection: { candidateId: 1, _id: 0 } })
    .toArray();
  const assignedCandidateIds = new Set(existingAssignments.map((assignment) => assignment.candidateId));

  for (const candidate of params.candidates) {
    // Skip lifetime same-account and request-local duplicates before allocating any quota slot.
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
