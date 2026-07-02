import { prisma } from '../../config/database';

/// The current legal version. Bump this (via the LEGAL_VERSION env var so it
/// can change without a code deploy) whenever the Terms of Service, Privacy
/// Policy, or Community Guidelines change materially — users whose
/// `acceptedLegalVersion` is lower are re-prompted to accept.
export const CURRENT_LEGAL_VERSION = Number(process.env.LEGAL_VERSION ?? 1);

// Canonical, editable-anytime document URLs (host these on the website).
const DOCS = {
  termsUrl:
    process.env.LEGAL_TERMS_URL ?? 'https://yomeet.app/terms-of-service',
  privacyUrl:
    process.env.LEGAL_PRIVACY_URL ?? 'https://yomeet.app/privacy-policy',
  guidelinesUrl:
    process.env.LEGAL_GUIDELINES_URL ??
    'https://yomeet.app/community-guidelines',
};

export function getCurrentLegal() {
  return { version: CURRENT_LEGAL_VERSION, ...DOCS };
}

/// Records an acceptance (append-only audit row) and advances the user's
/// quick-lookup `acceptedLegalVersion` to the highest version accepted.
export async function recordConsent(
  userId: string,
  version: number,
  platform?: string,
  appVersion?: string,
) {
  await prisma.legalConsent.create({
    data: {
      userId,
      version,
      platform: platform ?? null,
      appVersion: appVersion ?? null,
    },
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { acceptedLegalVersion: true },
  });
  if ((user?.acceptedLegalVersion ?? 0) < version) {
    await prisma.user.update({
      where: { id: userId },
      data: { acceptedLegalVersion: version },
    });
  }
}
