import { Router } from 'express';
import { verifyInternalApiKey } from '../../middleware/internalAuth.middleware';
import { discoverCandidates, saveEnrichment } from './leadCandidate.controller';

const router = Router();

router.post('/discovered', verifyInternalApiKey, discoverCandidates);
router.post('/:id/enrichment', verifyInternalApiKey, saveEnrichment);

export default router;
