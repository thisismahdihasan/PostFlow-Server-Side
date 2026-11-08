import { ObjectId } from 'mongodb';
import { getDB } from '../../config/db';
import {
  LeadCandidate,
  DiscoveredLeadCandidateInput,
  LeadCandidateEnrichmentInput,
  EnrichmentNeededLeadCandidate,
  DiscoverLeadCandidatesResponse,
} from './leadCandidate.types';

const getCollection = () => getDB().collection<LeadCandidate>('leadCandidates');
const MAX_ENRICHMENT_ATTEMPTS = 3;
const ENRICHMENT_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

const normalizeUsername = (username: string): string => username.trim().toLowerCase();

const normalizeStringArray = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];

  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
};

const toEnrichmentNeeded = (candidate: LeadCandidate): EnrichmentNeededLeadCandidate => ({
  leadCandidateId: candidate._id!.toString(),
  username: candidate.username,
  ...(candidate.instagramUserId ? { instagramUserId: candidate.instagramUserId } : {}),
  ...(candidate.profilePicUrl ? { profilePicUrl: candidate.profilePicUrl } : {}),
});

const needsEnrichment = (candidate: LeadCandidate, now: Date): boolean => {
  if (candidate.qualificationStatus !== 'pending') return false;
  if (candidate.enrichmentStatus === 'pending') return true;

  return (
    candidate.enrichmentStatus === 'failed' &&
    (candidate.enrichmentAttemptCount || 0) < MAX_ENRICHMENT_ATTEMPTS &&
    (!candidate.nextEnrichmentRetryAt || candidate.nextEnrichmentRetryAt <= now)
  );
};

const findCandidate = async (
  username: string,
  instagramUserId?: string
): Promise<LeadCandidate | null> => {
  const collection = getCollection();
  if (instagramUserId) {
    const byInstagramUserId = await collection.findOne({ instagramUserId });
    if (byInstagramUserId) return byInstagramUserId;
  }

  return collection.findOne({ username });
};

export const discoverLeadCandidates = async (
  inputs: DiscoveredLeadCandidateInput[]
): Promise<DiscoverLeadCandidatesResponse> => {
  let createdCount = 0;
  let updatedCount = 0;
  const enrichmentNeeded = new Map<string, EnrichmentNeededLeadCandidate>();
  const collection = getCollection();

  for (const input of inputs) {
    if (!input || typeof input.commenterUsername !== 'string') continue;

    const username = normalizeUsername(input.commenterUsername);
    if (!username) continue;

    const instagramUserId =
      typeof input.commenterInstagramId === 'string' && input.commenterInstagramId.trim()
        ? input.commenterInstagramId.trim()
        : undefined;
    const sourceSeedAccountIds = normalizeStringArray(input.sourceSeedAccountIds);
    const now = new Date();

    let existing = await findCandidate(username, instagramUserId);
    let wasCreated = false;

    if (!existing) {
      const newCandidate: LeadCandidate = {
        username,
        ...(instagramUserId ? { instagramUserId } : {}),
        ...(typeof input.commenterProfilePicUrl === 'string' && input.commenterProfilePicUrl.trim()
          ? { profilePicUrl: input.commenterProfilePicUrl.trim() }
          : {}),
        ...(typeof input.commenterIsVerified === 'boolean'
          ? { isVerified: input.commenterIsVerified }
          : {}),
        sourceSeedAccountIds,
        firstSeenAt: now,
        lastSeenAt: now,
        enrichmentStatus: 'pending',
        qualificationStatus: 'pending',
        enrichmentAttemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };

      try {
        const result = await collection.insertOne(newCandidate);
        newCandidate._id = result.insertedId;
        existing = newCandidate;
        createdCount++;
        wasCreated = true;
      } catch (error: any) {
        if (error?.code !== 11000) throw error;
        existing = await findCandidate(username, instagramUserId);
        if (!existing) throw error;
      }
    }

    if (existing._id && !wasCreated) {
      const updateDoc: Partial<LeadCandidate> = {
        username,
        lastSeenAt: now,
        updatedAt: now,
        sourceSeedAccountIds: Array.from(
          new Set([...existing.sourceSeedAccountIds, ...sourceSeedAccountIds])
        ),
      };

      if (instagramUserId) updateDoc.instagramUserId = instagramUserId;
      if (typeof input.commenterProfilePicUrl === 'string' && input.commenterProfilePicUrl.trim()) {
        updateDoc.profilePicUrl = input.commenterProfilePicUrl.trim();
      }
      if (typeof input.commenterIsVerified === 'boolean') {
        updateDoc.isVerified = input.commenterIsVerified;
      }

      await collection.updateOne(
        { _id: existing._id },
        {
          $set: updateDoc,
        }
      );

      const updatedCandidate: LeadCandidate = {
        ...existing,
        ...updateDoc,
      };

      updatedCount++;

      if (needsEnrichment(updatedCandidate, now)) {
        enrichmentNeeded.set(existing._id.toString(), toEnrichmentNeeded(updatedCandidate));
      }
    } else if (existing._id && needsEnrichment(existing, now)) {
      enrichmentNeeded.set(existing._id.toString(), toEnrichmentNeeded(existing));
    }
  }

  return {
    totalReceived: inputs.length,
    createdCount,
    updatedCount,
    enrichmentNeededCount: enrichmentNeeded.size,
    enrichmentNeeded: Array.from(enrichmentNeeded.values()),
  };
};

export const saveLeadCandidateEnrichment = async (
  id: string,
  input: LeadCandidateEnrichmentInput
): Promise<LeadCandidate | null> => {
  if (!ObjectId.isValid(id)) return null;

  const collection = getCollection();
  const now = new Date();
  const nextAttemptCount = {
    $add: [{ $ifNull: ['$enrichmentAttemptCount', 0] }, 1],
  };
  const updateDoc: Record<string, unknown> = {
    enrichmentStatus: input.enrichmentStatus,
    enrichmentAttemptCount: nextAttemptCount,
    lastEnrichmentAttemptAt: now,
    updatedAt: now,
  };

  if (input.enrichmentStatus === 'failed') {
    updateDoc.nextEnrichmentRetryAt = {
      $cond: [
        { $lt: [nextAttemptCount, MAX_ENRICHMENT_ATTEMPTS] },
        new Date(now.getTime() + ENRICHMENT_RETRY_DELAY_MS),
        '$$REMOVE',
      ],
    };
  } else {
    updateDoc.nextEnrichmentRetryAt = '$$REMOVE';
  }

  if (input.qualificationStatus !== undefined) {
    updateDoc.qualificationStatus = input.qualificationStatus;
  }
  if (input.profile !== undefined) updateDoc.profile = input.profile;
  if (input.geography !== undefined) updateDoc.geography = input.geography;
  if (input.pugQualification !== undefined) updateDoc.pugQualification = input.pugQualification;

  return await collection.findOneAndUpdate(
    { _id: new ObjectId(id) },
    [{ $set: updateDoc }],
    { returnDocument: 'after' }
  );
};
