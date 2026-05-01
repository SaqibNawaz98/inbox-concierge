import { LEARNING_OPTIONAL_SETUP_MESSAGE } from "@/lib/learningSetupMessage";

/** True when Prisma can use the Postgres datasource (learning + saved buckets). */
export function isLearningDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

/** Map Prisma/env noise to a single actionable line for the UI. */
export function friendlyLearningInfrastructureError(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes("environment variable not found: database_url") ||
    lower.includes("datasource") && lower.includes("database_url")
  ) {
    return LEARNING_OPTIONAL_SETUP_MESSAGE;
  }
  return raw.slice(0, 280);
}
