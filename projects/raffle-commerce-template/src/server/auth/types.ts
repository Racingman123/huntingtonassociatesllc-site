export type AuthField =
  | "name"
  | "email"
  | "password"
  | "confirmPassword"
  | "acceptTerms";

export type AuthActionState = {
  status: "idle" | "error";
  message?: string;
  errors?: Partial<Record<AuthField, string[]>>;
};

export const initialAuthActionState: AuthActionState = { status: "idle" };

export type AccountChallengeActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  errors?: Partial<Record<"email" | "password" | "confirmPassword" | "token", string[]>>;
};

export const initialAccountChallengeActionState: AccountChallengeActionState = { status: "idle" };

export type AuthViewer = {
  sessionId: string;
  sessionExpiresAt: Date;
  userId: string;
  tenantId: string;
  role: string;
  name: string;
  email: string;
  tenant: {
    slug: string;
    displayName: string;
    legalName: string;
    supportEmail: string;
    currency: string;
    timezone: string;
  };
};
