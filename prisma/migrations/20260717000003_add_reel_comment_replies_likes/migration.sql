-- Reel comment replies (2-level threading) + comment likes. Additive.
ALTER TABLE "ReelComment" ADD COLUMN "parentId" TEXT;
ALTER TABLE "ReelComment" ADD COLUMN "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReelComment" ADD COLUMN "replyCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "ReelComment_parentId_createdAt_idx" ON "ReelComment"("parentId", "createdAt");
ALTER TABLE "ReelComment" ADD CONSTRAINT "ReelComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ReelComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReelCommentLike" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReelCommentLike_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReelCommentLike_commentId_userId_key" ON "ReelCommentLike"("commentId", "userId");
CREATE INDEX "ReelCommentLike_commentId_idx" ON "ReelCommentLike"("commentId");
ALTER TABLE "ReelCommentLike" ADD CONSTRAINT "ReelCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ReelComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReelCommentLike" ADD CONSTRAINT "ReelCommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
