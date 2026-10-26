import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Bell notifications (P-10). Modules create them now; the bell and its list are built with P-08 to P-11.
 * Text is stored resolved (exact Section 21 wording at the time it was created).
 */
const notificationSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ntf') },
    accountId: { type: String, default: null },
    userId: { type: String, required: true },
    kind: { type: String, required: true }, // e.g. PROFILE_MILESTONE, KYC_VERIFIED
    messageId: { type: String, required: true },
    message: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: string };
export const Notification = model('Notification', notificationSchema, 'notifications'); 