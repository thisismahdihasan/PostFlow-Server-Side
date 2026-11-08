import { Request, Response } from 'express';
import catchAsync from '../../utils/catchAsync';
import * as leadCandidateService from './leadCandidate.service';
import {
  LeadCandidateEnrichmentStatus,
  LeadCandidateQualificationStatus,
} from './leadCandidate.types';

export const discoverCandidates = catchAsync(async (req: Request, res: Response) => {
  const { candidates } = req.body;

  if (!Array.isArray(candidates)) {
    return res.status(400).json({ message: 'Invalid payload: candidates array is required' });
  }

  const result = await leadCandidateService.discoverLeadCandidates(candidates);
  return res.status(200).json(result);
});

export const saveEnrichment = catchAsync(async (req: Request, res: Response) => {
  const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  const { enrichmentStatus, qualificationStatus, profile, geography, pugQualification } = req.body;

  const validEnrichmentStatuses: LeadCandidateEnrichmentStatus[] = ['completed', 'failed'];
  const validQualificationStatuses: LeadCandidateQualificationStatus[] = ['qualified', 'rejected'];

  if (!validEnrichmentStatuses.includes(enrichmentStatus)) {
    return res.status(400).json({ message: 'enrichmentStatus must be completed or failed' });
  }
  if (
    qualificationStatus !== undefined &&
    !validQualificationStatuses.includes(qualificationStatus)
  ) {
    return res.status(400).json({ message: 'qualificationStatus must be qualified or rejected' });
  }

  const candidate = await leadCandidateService.saveLeadCandidateEnrichment(id, {
    enrichmentStatus,
    qualificationStatus,
    profile,
    geography,
    pugQualification,
  });

  if (!candidate) {
    return res.status(404).json({ message: 'Lead candidate not found' });
  }

  return res.status(200).json(candidate);
});
