/** Builds every index (unique business rules included, GR-12). Run once per release in production (autoIndex is off there). */
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import '../config/cfg.js';
import '../middleware/idempotency.js';
import '../modules/accounts/account.model.js';
import '../modules/users/user.model.js';
import '../modules/auth/otp.model.js';
import '../modules/auth/session.model.js';
import '../modules/audit/audit.model.js';
import '../modules/tasks/task.model.js';
import '../modules/leads/lead.model.js';
import '../modules/customers/customer.model.js';

await connectMongo();
for (const name of mongoose.modelNames()) {
  const dropped = await mongoose.model(name).syncIndexes();
  console.log(`${name}: indexes in sync${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}`);
}
await disconnectMongo();
