const { env, prisma, adapterCreateUser, membershipsOnSignup } = vi.hoisted(
  () => ({
    env: {
      AUTH_SIGNUP_INVITE_ONLY: "true" as string | undefined,
      AUTH_DISABLE_SIGNUP: undefined as string | undefined,
      NEXT_PUBLIC_SIGN_UP_DISABLED: undefined as string | undefined,
      AUTH_SESSION_MAX_AGE: 20160,
      NEXTAUTH_SECRET: "test-secret",
      NEXTAUTH_URL: "http://localhost:3000",
    },
    prisma: {
      membershipInvitation: { findFirst: vi.fn() },
      user: { findUnique: vi.fn() },
    },
    adapterCreateUser: vi.fn(),
    membershipsOnSignup: vi.fn(),
  }),
);

vi.mock("@/src/env.mjs", () => ({ env }));
vi.mock("@langfuse/shared/src/db", () => ({ prisma }));
vi.mock("@next-auth/prisma-adapter", () => ({
  PrismaAdapter: () => ({ createUser: adapterCreateUser }),
}));
vi.mock("@/src/features/auth/lib/createProjectMembershipsOnSignup", () => ({
  createProjectMembershipsOnSignup: membershipsOnSignup,
}));
vi.mock("@/src/features/auth-credentials/lib/credentialsServerUtils", () => ({
  createUserEmailPassword: vi.fn(),
  consumeEmailOtpAndUpdatePassword: vi.fn(),
  hashEmailOtpToken: vi.fn(),
}));
vi.mock("@/src/ee/features/multi-tenant-sso/utils", () => ({
  findMultiTenantSsoConfig: vi.fn(),
  getSsoAuthProviderIdForDomain: vi.fn(async () => null),
  loadSsoProviders: vi.fn(async () => []),
}));

import type { AdapterUser } from "next-auth/adapters";

import { getAuthOptions } from "@/src/server/auth";
import { INVITE_ONLY_SIGNUP_MESSAGE } from "@/src/features/auth/server/signupInvitation";

const invitee = "invitee@example.com";
const stranger = "stranger@example.com";

const profile = (email: string): Omit<AdapterUser, "id"> => ({
  email,
  name: "New User",
  emailVerified: null,
});

async function adapterCreateUserGate() {
  const adapter = (await getAuthOptions()).adapter;
  if (!adapter?.createUser) throw new Error("adapter.createUser is missing");
  return adapter.createUser;
}

describe("NextAuth adapter createUser invite-only gate", () => {
  beforeEach(() => {
    env.AUTH_SIGNUP_INVITE_ONLY = "true";
    env.AUTH_DISABLE_SIGNUP = undefined;
    env.NEXT_PUBLIC_SIGN_UP_DISABLED = undefined;
    adapterCreateUser.mockReset();
    membershipsOnSignup.mockReset();
    prisma.membershipInvitation.findFirst
      .mockReset()
      .mockImplementation(async ({ where }) =>
        where.email === invitee ? { id: "invitation-1" } : null,
      );
    prisma.user.findUnique.mockReset().mockResolvedValue(null);
  });

  it("rejects a first sign-in for an email without an invitation", async () => {
    const createUser = await adapterCreateUserGate();

    await expect(createUser(profile(stranger))).rejects.toThrow(
      INVITE_ONLY_SIGNUP_MESSAGE,
    );

    expect(adapterCreateUser).not.toHaveBeenCalled();
  });

  it("creates the account for an invited email", async () => {
    adapterCreateUser.mockResolvedValue({ id: "user-1", ...profile(invitee) });
    const createUser = await adapterCreateUserGate();

    await expect(createUser(profile(invitee))).resolves.toMatchObject({
      id: "user-1",
    });

    expect(adapterCreateUser).toHaveBeenCalledOnce();
  });

  it("keeps first sign-in open while the flag is off", async () => {
    env.AUTH_SIGNUP_INVITE_ONLY = undefined;
    adapterCreateUser.mockResolvedValue({ id: "user-2", ...profile(stranger) });
    const createUser = await adapterCreateUserGate();

    await expect(createUser(profile(stranger))).resolves.toMatchObject({
      id: "user-2",
    });

    expect(prisma.membershipInvitation.findFirst).not.toHaveBeenCalled();
  });
});
