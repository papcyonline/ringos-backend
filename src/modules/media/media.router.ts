import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { streamFromDrive } from '../../shared/gdrive.service';

const router = Router();

/**
 * GET /media/gdrive/:fileId
 * Authenticated proxy — streams a private Google Drive file to the client.
 */
router.get('/gdrive/:fileId', authenticate, async (req, res) => {
  const fileId = req.params.fileId as string;

  const ok = await streamFromDrive(fileId, res);
  if (!ok) {
    res.status(404).json({ error: 'File not found' });
  }
});

export { router as mediaRouter };
