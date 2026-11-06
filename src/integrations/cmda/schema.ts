import { z } from 'zod';
export const memberSync=z.object({
 eventId:z.uuid(),memberId:z.string().regex(/^[a-f0-9]{24}$/),revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
 sourceUpdatedAt:z.iso.datetime(),email:z.email().max(320).transform(s=>s.toLowerCase()),firstName:z.string().max(200),fullName:z.string().max(600),membershipId:z.string().max(100),
 role:z.string().max(100),region:z.string().max(200),memberCategory:z.string().max(200),isGlobal:z.boolean(),
 paidMembership:z.boolean(),subscriptionExpiry:z.union([z.iso.datetime(),z.null()]),lifetimeMembership:z.boolean(),
 emailVerified:z.boolean(),active:z.boolean(),banned:z.boolean(),deleted:z.boolean().default(false),
 marketingConsent:z.boolean(),emailNotifications:z.boolean(),
 consentChangedAt:z.union([z.iso.datetime(),z.null()]),consentFeedbackSequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();
export type MemberSync=z.infer<typeof memberSync>;
