-- Additive, personal-instance-only mapping. No existing users/documents are changed.
CREATE TABLE "PortalSigningIdentity" (
    "portalAgentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "googleSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "grantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PortalSigningIdentity_pkey" PRIMARY KEY ("portalAgentId"),
    CONSTRAINT "PortalSigningIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PortalSigningIdentity_userId_key" ON "PortalSigningIdentity"("userId");
CREATE UNIQUE INDEX "PortalSigningIdentity_googleSubject_key" ON "PortalSigningIdentity"("googleSubject");
