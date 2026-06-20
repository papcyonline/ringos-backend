import { prisma } from '../../config/database';
import { AnnouncementSeverity } from '@prisma/client';

/// Shape returned to clients.
export interface AnnouncementPayload {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  dismissible: boolean;
  ctaText: string | null;
  ctaUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

function toPayload(a: {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  dismissible: boolean;
  ctaText: string | null;
  ctaUrl: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}): AnnouncementPayload {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    severity: a.severity,
    dismissible: a.dismissible,
    ctaText: a.ctaText,
    ctaUrl: a.ctaUrl,
    startsAt: a.startsAt?.toISOString() ?? null,
    endsAt: a.endsAt?.toISOString() ?? null,
  };
}

/// The single currently-active announcement (active, within its time window),
/// most recent first. Null when there's nothing to show.
export async function getActiveAnnouncement(): Promise<AnnouncementPayload | null> {
  const now = new Date();
  const a = await prisma.announcement.findFirst({
    where: {
      active: true,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  return a ? toPayload(a) : null;
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  severity?: AnnouncementSeverity;
  dismissible?: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  ctaText?: string | null;
  ctaUrl?: string | null;
}

export async function createAnnouncement(
  input: CreateAnnouncementInput,
): Promise<AnnouncementPayload> {
  const a = await prisma.announcement.create({
    data: {
      title: input.title,
      body: input.body,
      severity: input.severity ?? 'INFO',
      dismissible: input.dismissible ?? true,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      ctaText: input.ctaText ?? null,
      ctaUrl: input.ctaUrl ?? null,
    },
  });
  return toPayload(a);
}

/// Deactivate an announcement (so it stops showing). Used by admin to pull a
/// notice early. Idempotent.
export async function deactivateAnnouncement(id: string): Promise<void> {
  await prisma.announcement.updateMany({
    where: { id },
    data: { active: false },
  });
}
