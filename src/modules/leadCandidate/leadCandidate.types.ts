import { ObjectId } from 'mongodb';

export type LeadCandidateEnrichmentStatus = 'pending' | 'completed' | 'failed';
export type LeadCandidateQualificationStatus = 'pending' | 'qualified' | 'rejected';

export interface LeadCandidate {
  _id?: ObjectId;
  username: string;
  instagramUserId?: string;

  profilePicUrl?: string;
  isVerified?: boolean;

  observedCommentCount: number;
  sourcePostIds: string[];
  sourceSeedAccountIds: string[];
  sourceSeedUsernames: string[];

  firstSeenAt: Date;
  lastSeenAt: Date;

  enrichmentStatus: LeadCandidateEnrichmentStatus;
  qualificationStatus: LeadCandidateQualificationStatus;
  enrichmentAttemptCount: number;
  lastEnrichmentAttemptAt?: Date;
  nextEnrichmentRetryAt?: Date;

  profile?: {
    biography?: string;
    displayName?: string;
    followersCount?: number;
    followingCount?: number;
  };

  geography?: {
    countryCode?: string;
    isTargetGeography?: boolean;
  };

  pugQualification?: {
    isPugRelevant?: boolean;
  };

  createdAt: Date;
  updatedAt: Date;
}

export interface DiscoveredLeadCandidateInput {
  commenterUsername: string;
  commenterInstagramId?: string;
  commenterProfilePicUrl?: string;
  commenterIsVerified?: boolean;
  observedCommentCount: number;
  sourcePostIds: string[];
  sourceSeedAccountIds: string[];
  sourceSeedUsernames: string[];
  latestCommentedAt?: string;
}

export interface LeadCandidateEnrichmentInput {
  enrichmentStatus: 'completed' | 'failed';
  qualificationStatus?: 'qualified' | 'rejected';
  profile?: LeadCandidate['profile'];
  geography?: LeadCandidate['geography'];
  pugQualification?: LeadCandidate['pugQualification'];
}

export interface EnrichmentNeededLeadCandidate {
  leadCandidateId: string;
  username: string;
  instagramUserId?: string;
  profilePicUrl?: string;
}

export interface DiscoverLeadCandidatesResponse {
  totalReceived: number;
  createdCount: number;
  updatedCount: number;
  enrichmentNeededCount: number;
  enrichmentNeeded: EnrichmentNeededLeadCandidate[];
}
