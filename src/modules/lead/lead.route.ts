import { Router } from 'express';
import { verifyFirebaseToken } from '../../middleware/auth.middleware';
import { verifyInternalApiKey } from '../../middleware/internalAuth.middleware';
import {
  getQuotaSummary,
  getVisibleLeads,
  updateLeadStatus,
  assignLeads,
  getAllAssignments,
  internalGetQuotaSummary,
  internalAssignLeads,
  getDailyDemand,
  getMyActivity,
  getActivitySummary,
} from './lead.controller';

const router = Router();

// User / Worker / Admin routes (authenticated)
router.get('/quota-summary', verifyFirebaseToken, getQuotaSummary);
router.get('/visible', verifyFirebaseToken, getVisibleLeads);
router.get('/my-activity', verifyFirebaseToken, getMyActivity);
router.get('/activity-summary', verifyFirebaseToken, getActivitySummary);
router.patch('/:assignmentId/status', verifyFirebaseToken, updateLeadStatus);
router.get('/all', verifyFirebaseToken, getAllAssignments);
router.post('/assign', verifyFirebaseToken, assignLeads);

export default router;

// Internal API routes (for cron / n8n)
const internalRouter = Router();
internalRouter.get('/daily-demand', verifyInternalApiKey, getDailyDemand);
internalRouter.get('/quota-summary', verifyInternalApiKey, internalGetQuotaSummary);
internalRouter.post('/assign', verifyInternalApiKey, internalAssignLeads);

export const internalLeadRouter = internalRouter;
