export type AccountOrderLine = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPriceCents: number;
  entries: string;
};

export type AccountOrder = {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  entryTotal: string;
  createdAt: Date;
  paidAt: Date | null;
  campaign: { code: string; title: string; slug: string } | null;
  lines: AccountOrderLine[];
  payments: Array<{ status: string; amountCents: number; processedAt: Date | null }>;
};

export type AccountLedgerItem = {
  id: string;
  kind: string;
  delta: string;
  balanceContext: string;
  reasonCode: string;
  effectiveAt: Date;
  recordedAt: Date;
  actorType: string;
  campaign: { code: string; title: string; slug: string };
  originType: string | null;
  sourceReference: string | null;
};

export type AccountEntryPool = {
  id: string;
  balance: string;
  campaign: {
    code: string;
    title: string;
    slug: string;
    status: string;
    endsAt: Date;
  };
};

export type AccountData = {
  viewer: {
    id: string;
    name: string;
    email: string;
    role: string;
    createdAt: Date;
    emailVerifiedAt: Date | null;
    lastLoginAt: Date | null;
    sessionExpiresAt: Date;
    activeSessionCount: number;
    tenant: {
      currency: string;
    };
  };
  entrant: {
    name: string;
    phone: string | null;
    region: string | null;
    postalCode: string | null;
    eligibilityAttested: boolean;
  } | null;
  orders: AccountOrder[];
  entryPools: AccountEntryPool[];
  ledger: AccountLedgerItem[];
  totals: {
    orderCount: number;
    capturedSpendCents: number;
    activeEntries: string;
  };
};

export type ProfileActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  errors?: Partial<Record<"name" | "phone" | "currentPassword" | "newPassword" | "confirmPassword", string[]>>;
};

export const initialProfileActionState: ProfileActionState = { status: "idle" };
