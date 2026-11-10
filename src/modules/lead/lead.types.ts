import { ObjectId } from 'mongodb';

export type LeadAssignmentStatus = 'pending' | 'followed' | 'skipped' | 'rejected';
export type LeadSource = 'auto' | 'manual';

export interface LeadAssignment {
  _id?: ObjectId;
  candidateId: string;
  candidateUsername?: string;
  targetAccountId: ObjectId;
  accountSlug?: string;
  assignedDate: string; // YYYY-MM-DD
  status: LeadAssignmentStatus;
  isReserve: boolean;
  batchIndex?: number;
  availableAt?: Date; // UTC Date timestamp
  source: LeadSource;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
  processedByFirebaseUid?: string;
  processedAt?: Date;
}

export interface WorkerVisibleLead extends LeadAssignment {
  profilePicUrl?: string;
}

export interface ProcessingActivityCounts {
  followed: number;
  skipped: number;
  completed: number;
}

export interface AssignmentCohortCounts {
  assigned: number;
  pending: number;
  followed: number;
  skipped: number;
  rejected: number;
}

export interface ReleaseBatchInfo {
  batchIndex: number;
  size: number;
  availableAt: Date;
  offsetMinutes: number;
}

export interface LeadQuotaSummary {
  targetAccountId: string;
  accountSlug: string;
  assignedDate: string;
  visibleTarget: number;
  bufferPercent: number;
  generationTarget: number;
  assignedNormalCount: number;
  reserveCount: number;
  totalAssignedCount: number;
  remainingNormalNeed: number;
  remainingGenerationNeed: number;
  releaseBatches: ReleaseBatchInfo[];
}

export interface AssignCandidateInput {
  candidateId: string;
  candidateUsername?: string;
  source?: LeadSource;
  metadata?: Record<string, any>;
}

export interface SavedQualifiedCandidate {
  candidateId: string;
  candidateUsername: string;
  source: 'auto';
}

export interface SavedQualifiedCandidatesResult {
  account: string;
  date: string;
  remainingGenerationNeed: number;
  candidates: SavedQualifiedCandidate[];
}

export interface AccountDemandItem {
  targetAccountId: string;
  accountSlug: string;
  displayName: string;
  targetDate: string;
  dailyLeadTarget: number;
  alreadyAssignedQualified: number;
  remainingRequired: number;
  bufferPercent: number;
  generationTarget: number;
  remainingGenerationNeed: number;
  shouldScrape: boolean;
}

export interface DailyDemandSummary {
  targetDate: string;
  timezone: string;
  accounts: AccountDemandItem[];
}
