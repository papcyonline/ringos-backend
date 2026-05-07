-- Multi-image album support. New messages with N>=2 images write the
-- full URL list to imageUrls; imageUrl is still set to imageUrls[0] so
-- pre-album clients (and existing rows) keep rendering correctly.
ALTER TABLE "Message" ADD COLUMN "imageUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
