import { env } from "@/src/env.mjs";
import { prisma } from "@langfuse/shared/src/db";

export const INVITE_ONLY_SIGNUP_MESSAGE =
  "Sign up is by invitation only. Ask an organization admin to invite this email address.";

/**
 * Decides whether a new account may be created for an email address.
 *
 * While `AUTH_SIGNUP_INVITE_ONLY` is `"true"`, a pending organization invitation is what admits a
 * new account. An existing account row passes too, because the email-verified sign-up turns the
 * invitation into a membership before the user sets a password, so an abandoned attempt must stay
 * resumable.
 */
export async function isSignupAllowedForEmail(email: string): Promise<boolean> {
  if (env.AUTH_SIGNUP_INVITE_ONLY !== "true") return true;

  const normalizedEmail = email.toLowerCase();

  const invitation = await prisma.membershipInvitation.findFirst({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (invitation) return true;

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  return existingUser !== null;
}
