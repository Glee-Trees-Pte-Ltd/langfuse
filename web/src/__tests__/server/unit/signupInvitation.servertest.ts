const { env, prisma, ssoProviderForDomain } = vi.hoisted(() => ({
  env: {
    AUTH_SIGNUP_INVITE_ONLY: undefined as string | undefined,
    AUTH_DISABLE_SIGNUP: undefined as string | undefined,
    AUTH_DISABLE_USERNAME_PASSWORD: undefined as string | undefined,
    AUTH_DOMAINS_WITH_SSO_ENFORCEMENT: undefined as string | undefined,
    NEXT_PUBLIC_SIGN_UP_DISABLED: undefined as string | undefined,
    AUTH_EMAIL_VERIFICATION_REQUIRED: undefined as string | undefined,
    SMTP_CONNECTION_URL: undefined as string | undefined,
    EMAIL_FROM_ADDRESS: undefined as string | undefined,
  },
  prisma: {
    membershipInvitation: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  ssoProviderForDomain: vi.fn(),
}));

vi.mock("@/src/env.mjs", () => ({ env }));
vi.mock("@langfuse/shared/src/db", () => ({ prisma }));
vi.mock("@langfuse/shared/src/server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/src/ee/features/multi-tenant-sso/server", () => ({
  getSsoAuthProviderIdForDomain: ssoProviderForDomain,
}));
vi.mock("@/src/features/auth-credentials/lib/credentialsServerUtils", () => ({
  createUserEmailPassword: vi.fn(),
}));

import { Prisma } from "@prisma/client";

import { createUserEmailPassword } from "@/src/features/auth-credentials/lib/credentialsServerUtils";
import {
  signupApiHandler,
  validateSignupEligibility,
} from "@/src/features/auth-credentials/server/signupApiHandler";
import {
  INVITE_ONLY_SIGNUP_MESSAGE,
  isSignupAllowedForEmail,
} from "@/src/features/auth/server/signupInvitation";

const createUserEmailPasswordMock = vi.mocked(createUserEmailPassword);

const invitee = "invitee@example.com";
const stranger = "stranger@example.com";

function givenInvitationExists(exists: boolean) {
  prisma.membershipInvitation.findFirst.mockImplementation(async ({ where }) =>
    exists && where.email === invitee ? { id: "invitation-1" } : null,
  );
}

function givenAccountExists(exists: boolean) {
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    exists && where.email === invitee ? { id: "user-1" } : null,
  );
}

function fakeResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function postSignup(body: unknown) {
  const res = fakeResponse();
  return signupApiHandler(
    { method: "POST", body, headers: {} } as never,
    res as never,
  ).then(() => res);
}

describe("isSignupAllowedForEmail", () => {
  beforeEach(() => {
    env.AUTH_SIGNUP_INVITE_ONLY = "true";
    prisma.membershipInvitation.findFirst.mockReset();
    prisma.user.findUnique.mockReset();
  });

  it("admits every email while the flag is off", async () => {
    env.AUTH_SIGNUP_INVITE_ONLY = undefined;

    await expect(isSignupAllowedForEmail(stranger)).resolves.toBe(true);

    expect(prisma.membershipInvitation.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("admits an email with a pending invitation", async () => {
    givenInvitationExists(true);

    await expect(isSignupAllowedForEmail(invitee)).resolves.toBe(true);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("admits an existing account whose invited sign-up has not finished", async () => {
    givenInvitationExists(false);
    givenAccountExists(true);

    await expect(isSignupAllowedForEmail(invitee)).resolves.toBe(true);
  });

  it("rejects an email with neither an invitation nor an account", async () => {
    givenInvitationExists(false);
    givenAccountExists(false);

    await expect(isSignupAllowedForEmail(stranger)).resolves.toBe(false);
  });

  it("matches a pending invitation by lowercased email", async () => {
    givenInvitationExists(true);

    await expect(isSignupAllowedForEmail("Invitee@Example.COM")).resolves.toBe(
      true,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("matches an existing account by lowercased email", async () => {
    givenInvitationExists(false);
    givenAccountExists(true);

    await expect(isSignupAllowedForEmail("Invitee@Example.COM")).resolves.toBe(
      true,
    );
  });

  it("rejects instead of admitting when the invitation lookup fails", async () => {
    prisma.membershipInvitation.findFirst.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("connection refused", {
        code: "P1001",
        clientVersion: Prisma.prismaVersion.client,
      }),
    );

    await expect(isSignupAllowedForEmail(invitee)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});

describe("validateSignupEligibility invite-only gate", () => {
  beforeEach(() => {
    env.AUTH_SIGNUP_INVITE_ONLY = "true";
    env.AUTH_DISABLE_SIGNUP = undefined;
    env.AUTH_DISABLE_USERNAME_PASSWORD = undefined;
    env.AUTH_DOMAINS_WITH_SSO_ENFORCEMENT = undefined;
    env.NEXT_PUBLIC_SIGN_UP_DISABLED = undefined;
    ssoProviderForDomain.mockResolvedValue(null);
    prisma.membershipInvitation.findFirst.mockReset();
    prisma.user.findUnique.mockReset();
    givenInvitationExists(false);
    givenAccountExists(false);
  });

  it("returns the invite-only message for an email without an invitation", async () => {
    await expect(validateSignupEligibility({ email: stranger })).resolves.toBe(
      INVITE_ONLY_SIGNUP_MESSAGE,
    );
  });

  it("accepts an invited email", async () => {
    givenInvitationExists(true);

    await expect(validateSignupEligibility({ email: invitee })).resolves.toBe(
      null,
    );
  });

  it("keeps the sign-up kill switch ahead of the invitation", async () => {
    env.AUTH_DISABLE_SIGNUP = "true";
    givenInvitationExists(true);

    await expect(validateSignupEligibility({ email: invitee })).resolves.toBe(
      "Sign up is disabled.",
    );

    expect(prisma.membershipInvitation.findFirst).not.toHaveBeenCalled();
  });

  it("keeps open sign-up while the flag is off", async () => {
    env.AUTH_SIGNUP_INVITE_ONLY = undefined;

    await expect(validateSignupEligibility({ email: stranger })).resolves.toBe(
      null,
    );
  });

  it("rejects instead of admitting when the invitation lookup fails", async () => {
    prisma.membershipInvitation.findFirst.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("connection refused", {
        code: "P1001",
        clientVersion: Prisma.prismaVersion.client,
      }),
    );

    await expect(
      validateSignupEligibility({ email: invitee }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});

describe("signupApiHandler direct sign-up gate", () => {
  beforeEach(() => {
    env.AUTH_SIGNUP_INVITE_ONLY = "true";
    env.AUTH_EMAIL_VERIFICATION_REQUIRED = undefined;
    env.SMTP_CONNECTION_URL = undefined;
    env.EMAIL_FROM_ADDRESS = undefined;
    env.AUTH_DISABLE_SIGNUP = undefined;
    env.NEXT_PUBLIC_SIGN_UP_DISABLED = undefined;
    ssoProviderForDomain.mockResolvedValue(null);
    prisma.membershipInvitation.findFirst.mockReset();
    prisma.user.findUnique.mockReset();
    givenInvitationExists(true);
    createUserEmailPasswordMock.mockReset();
  });

  it("refuses direct password sign-up while invite-only is on, even without SMTP", async () => {
    const res = await postSignup({
      email: invitee,
      name: "Invitee",
      password: "Invitee@pass123",
    });

    expect(res.statusCode).toBe(403);
    expect(createUserEmailPasswordMock).not.toHaveBeenCalled();
  });

  it("lets direct password sign-up reach body validation while the flag is off", async () => {
    env.AUTH_SIGNUP_INVITE_ONLY = undefined;

    const res = await postSignup({ email: "not-an-email" });

    expect(res.statusCode).toBe(422);
    expect(createUserEmailPasswordMock).not.toHaveBeenCalled();
  });
});
