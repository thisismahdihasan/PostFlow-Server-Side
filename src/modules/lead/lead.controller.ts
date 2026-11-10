import { Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import catchAsync from '../../utils/catchAsync';
import * as leadService from './lead.service';
import * as userService from '../user/user.service';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidLeadDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const checkApprovedUser = async (uid: string) => {
  const user = await userService.findUserByFirebaseUid(uid);
  if (!user || user.status !== 'approved') {
    return null;
  }
  return user;
};

export const getQuotaSummary = catchAsync(async (req: Request, res: Response) => {
  const { uid } = req.user!;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const user = await checkApprovedUser(uid);
  if (!user) return res.status(403).json({ message: 'Forbidden' });

  const account = (req.query.account as string) || '';
  const date = (req.query.date as string) || '';

  if (!account.trim()) {
    return res.status(400).json({ message: 'query param account is required' });
  }

  if (!DATE_REGEX.test(date)) {
    return res.status(400).json({ message: 'query param date is required in YYYY-MM-DD format' });
  }

  try {
    const summary = await leadService.getDailyLeadQuotaSummary(account.trim(), date);
    return res.status(200).json(summary);
  } catch (err: any) {
    if (err.message?.includes('Account not found')) {
      return res.status(404).json({ message: err.message });
    }
    throw err;
  }
});

export const getVisibleLeads = catchAsync(async (req: Request, res: Response) => {
  const { uid } = req.user!;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const user = await checkApprovedUser(uid);
  if (!user) return res.status(403).json({ message: 'Forbidden' });

  const { account, date, page: pageQuery, limit: limitQuery } = req.query;

  if (typeof account !== 'string' || !account.trim()) {
    return res.status(400).json({ message: 'query param account is required' });
  }

  if (date !== undefined && !isValidLeadDate(date)) {
    return res.status(400).json({ message: 'query param date is required in YYYY-MM-DD format' });
  }

  const page = pageQuery === undefined ? 1
    : typeof pageQuery === 'string' && /^\d+$/.test(pageQuery) ? Number(pageQuery) : NaN;
  const limit = limitQuery === undefined ? 10
    : typeof limitQuery === 'string' && /^\d+$/.test(limitQuery) ? Number(limitQuery) : NaN;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger((page - 1) * limit)) {
    return res.status(400).json({ message: 'page must be a positive integer and limit must be an integer from 1 to 100' });
  }

  try {
    const { leads, totalCount } = await leadService.getWorkerVisibleLeads(account.trim(), date, page, limit);
    return res.status(200).json({
      account,
      date,
      count: leads.length,
      leads,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
    });
  } catch (err: any) {
    if (err.message?.includes('Account not found')) {
      return res.status(404).json({ message: err.message });
    }
    throw err;
  }
});

export const getMyActivity = catchAsync(async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });
  const user = await checkApprovedUser(uid);
  if (!user) return res.status(403).json({ message: 'Forbidden' });

  const { from, to } = req.query;
  if (from !== undefined || to !== undefined) {
    if (!isValidLeadDate(from) || !isValidLeadDate(to) || from > to) {
      return res.status(400).json({ message: 'from and to must be valid YYYY-MM-DD dates with from <= to' });
    }
    return res.status(200).json(await leadService.getMyLeadActivityRange(uid, from, to));
  }

  // Preserve the original Today/Yesterday response for existing consumers.
  return res.status(200).json(await leadService.getMyLeadActivity(uid));
});

export const getActivitySummary = catchAsync(async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });
  const user = await checkApprovedUser(uid);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: Admin only' });
  }
  const { account, date } = req.query;
  if (typeof account !== 'string' || !account.trim()) {
    return res.status(400).json({ message: 'query param account is required' });
  }
  if (!isValidLeadDate(date)) {
    return res.status(400).json({ message: 'query param date is required in YYYY-MM-DD format' });
  }
  return res.status(200).json(await leadService.getLeadActivitySummary(account.trim(), date));
});

export const updateLeadStatus = catchAsync(async (req: Request, res: Response) => {
  const uid = req.user?.uid;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const user = await checkApprovedUser(uid);
  if (!user) return res.status(403).json({ message: 'Forbidden' });

  const { assignmentId } = req.params;
  const { account, date, status } = req.body || {};

  if (typeof assignmentId !== 'string' || !ObjectId.isValid(assignmentId)) {
    return res.status(400).json({ message: 'Valid assignmentId is required' });
  }
  if (typeof account !== 'string' || !account.trim()) {
    return res.status(400).json({ message: 'account is required' });
  }
  if (!isValidLeadDate(date)) {
    return res.status(400).json({ message: 'date must be a valid date in YYYY-MM-DD format' });
  }
  if (status !== 'followed' && status !== 'skipped') {
    return res.status(400).json({ message: 'status must be followed or skipped' });
  }

  const assignment = await leadService.updateWorkerLeadStatus({
    assignmentId,
    accountIdOrSlug: account.trim(),
    assignedDate: date,
    status,
    processedByFirebaseUid: uid,
  });
  return res.status(200).json({ assignment });
});

export const assignLeads = catchAsync(async (req: Request, res: Response) => {
  const { uid } = req.user!;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const user = await checkApprovedUser(uid);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: Admin only' });
  }

  const { account, date, candidates, anchorTime } = req.body;

  if (!account || typeof account !== 'string') {
    return res.status(400).json({ message: 'account is required' });
  }

  if (!date || !DATE_REGEX.test(date)) {
    return res.status(400).json({ message: 'date is required in YYYY-MM-DD format' });
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ message: 'candidates must be a non-empty array' });
  }

  const parsedAnchorTime = anchorTime ? new Date(anchorTime) : undefined;
  if (anchorTime && isNaN(parsedAnchorTime!.getTime())) {
    return res.status(400).json({ message: 'Invalid anchorTime' });
  }

  try {
    const result = await leadService.assignLeadCandidates({
      accountIdOrSlug: account.trim(),
      assignedDate: date,
      candidates,
      anchorTime: parsedAnchorTime,
    });

    return res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes('Account not found')) {
      return res.status(404).json({ message: err.message });
    }
    throw err;
  }
});

export const getAllAssignments = catchAsync(async (req: Request, res: Response) => {
  const { uid } = req.user!;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const user = await checkApprovedUser(uid);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: Admin only' });
  }

  const account = (req.query.account as string) || '';
  const date = (req.query.date as string) || '';

  if (!account.trim() || !DATE_REGEX.test(date)) {
    return res.status(400).json({ message: 'Valid account and date query params are required' });
  }

  const assignments = await leadService.getAllLeadAssignmentsForDate(account.trim(), date);
  return res.status(200).json({
    account,
    date,
    count: assignments.length,
    assignments,
  });
});

// Internal handlers
export const internalGetQuotaSummary = catchAsync(async (req: Request, res: Response) => {
  const account = (req.query.account as string) || '';
  const date = (req.query.date as string) || '';

  if (!account.trim() || !DATE_REGEX.test(date)) {
    return res.status(400).json({ message: 'Valid account and date query params are required' });
  }

  const summary = await leadService.getDailyLeadQuotaSummary(account.trim(), date);
  return res.status(200).json(summary);
});

export const internalAssignLeads = catchAsync(async (req: Request, res: Response) => {
  const { account, date, candidates, anchorTime } = req.body;

  if (!account || typeof account !== 'string' || !date || !DATE_REGEX.test(date) || !Array.isArray(candidates)) {
    return res.status(400).json({ message: 'Invalid payload: account, date, and candidates array are required' });
  }

  const parsedAnchorTime = anchorTime ? new Date(anchorTime) : undefined;
  const result = await leadService.assignLeadCandidates({
    accountIdOrSlug: account.trim(),
    assignedDate: date,
    candidates,
    anchorTime: parsedAnchorTime,
  });

  return res.status(201).json(result);
});

export const getDailyDemand = catchAsync(async (req: Request, res: Response) => {
  const dateQuery = req.query.date as string | undefined;

  if (dateQuery !== undefined) {
    if (!DATE_REGEX.test(dateQuery.trim())) {
      return res.status(400).json({ message: 'query param date must be in YYYY-MM-DD format if provided' });
    }
  }

  const demandSummary = await leadService.getDailyDemandSummary(dateQuery?.trim());
  return res.status(200).json(demandSummary);
});
