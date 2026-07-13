"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getOptionalViewer } from "@/server/auth/dal";
import { db } from "@/server/db";
import {
  cancelSubscriptionAtPeriodEnd,
  createDemoSubscription,
  settleDemoSubscriptionRenewal,
} from "@/server/subscriptions/service";
import {
  acceptMembershipCampaignRules,
  createStripeBillingPortal,
  startStripeSubscriptionCheckout,
} from "@/server/subscriptions/stripe-service";
import {
  consumeRateLimits,
  getTrustedClientIp,
  publicRateLimitRules,
} from "@/server/security/rate-limit";

export type MembershipActionState = {
  status: "idle" | "error";
  message?: string;
};

const enrollmentSchema = z.object({
  planId: z.string().trim().min(1).max(191),
  idempotencyKey: z.string().trim().min(8).max(200),
  campaignId: z.string().trim().min(1).max(191).optional(),
  rulesAccepted: z.boolean(),
});

function safeMessage(error: unknown) {
  if (error instanceof Error && error.message.includes("already has an active subscription")) {
    return "This account already has an active membership. Open your account to manage it.";
  }
  return "We could not start the membership. No additional renewal was recorded; please try again.";
}

export async function joinMembershipAction(
  _previousState: MembershipActionState,
  formData: FormData,
): Promise<MembershipActionState> {
  const viewer = await getOptionalViewer();
  if (!viewer) redirect("/login?next=/membership");

  const parsed = enrollmentSchema.safeParse({
    planId: formData.get("planId"),
    idempotencyKey: formData.get("idempotencyKey"),
    campaignId: formData.get("campaignId") || undefined,
    rulesAccepted: formData.get("rulesAccepted") === "on"
      || formData.get("rulesAccepted") === "true",
  });
  if (!parsed.success) {
    return { status: "error", message: "This membership offer is no longer valid. Refresh and try again." };
  }

  const now = new Date();
  const [plan, entrant, entryCampaigns] = await Promise.all([
    db.subscriptionPlan.findFirst({
      where: { id: parsed.data.planId, tenantId: viewer.tenantId, status: "ACTIVE" },
      select: { id: true },
    }),
    db.entrant.findFirst({
      where: { tenantId: viewer.tenantId, userId: viewer.userId },
      select: { id: true },
    }),
    db.campaign.findMany({
      where: {
        tenantId: viewer.tenantId,
        status: "LIVE",
        startsAt: { lte: now },
        endsAt: { gt: now },
        membershipBands: { some: { planId: parsed.data.planId } },
      },
      select: { id: true },
      orderBy: [{ startsAt: "desc" }, { id: "asc" }],
      take: 2,
    }),
  ]);
  if (!plan || !entrant || entryCampaigns.length > 1) {
    return { status: "error", message: "Your account cannot use this membership offer." };
  }

  try {
    const trustedIp = await getTrustedClientIp();
    const limit = await consumeRateLimits({
      tenantId: viewer.tenantId,
      rules: publicRateLimitRules({
        scope: "membership-enrollment",
        subject: viewer.userId,
        subjectLimit: 5,
        ip: trustedIp,
        ipLimit: 30,
        windowSeconds: 15 * 60,
      }),
    });
    if (!limit.allowed) {
      return { status: "error", message: "Too many membership attempts. Please wait before trying again." };
    }
  } catch {
    return { status: "error", message: "Secure membership checkout is temporarily unavailable." };
  }

  const entryCampaign = entryCampaigns[0] ?? null;
  if (entryCampaign) {
    if (!parsed.data.rulesAccepted || parsed.data.campaignId !== entryCampaign.id) {
      return { status: "error", message: "Accept the exact current Official Rules before continuing." };
    }
    try {
      await acceptMembershipCampaignRules({
        tenantId: viewer.tenantId,
        campaignId: entryCampaign.id,
        entrantId: entrant.id,
        userId: viewer.userId,
      });
    } catch {
      return { status: "error", message: "The current promotion rules could not be verified. Refresh and try again." };
    }
  }

  if (process.env.DEMO_MODE !== "true") {
    try {
      const started = await startStripeSubscriptionCheckout({
        tenantId: viewer.tenantId,
        planId: plan.id,
        entrantId: entrant.id,
        userId: viewer.userId,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      redirect(started.redirectUrl as Route);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      return { status: "error", message: safeMessage(error) };
    }
  }

  let subscription = await db.subscription.findFirst({
    where: {
      tenantId: viewer.tenantId,
      planId: plan.id,
      userId: viewer.userId,
      status: { in: ["ACTIVE", "PAST_DUE"] },
    },
    select: { id: true, settledCycleCount: true, provider: true },
  });

  try {
    if (!subscription) {
      try {
        const created = await createDemoSubscription({
          tenantId: viewer.tenantId,
          planId: plan.id,
          entrantId: entrant.id,
          userId: viewer.userId,
          idempotencyKey: parsed.data.idempotencyKey,
        });
        subscription = {
          id: created.subscriptionId,
          settledCycleCount: created.settledCycleCount,
          provider: created.provider,
        };
      } catch (error) {
        // A concurrent double-submit can win the unique active-plan race. Reload
        // that record and continue only if it still needs its initial settlement.
        subscription = await db.subscription.findFirst({
          where: {
            tenantId: viewer.tenantId,
            planId: plan.id,
            userId: viewer.userId,
            status: { in: ["ACTIVE", "PAST_DUE"] },
          },
          select: { id: true, settledCycleCount: true, provider: true },
        });
        if (!subscription) throw error;
      }
    }

    if (subscription.settledCycleCount === 0 && subscription.provider === "DEMO") {
      await settleDemoSubscriptionRenewal({
        tenantId: viewer.tenantId,
        subscriptionId: subscription.id,
        idempotencyKey: `initial-cycle:${subscription.id}`,
      });
    }
  } catch (error) {
    return { status: "error", message: safeMessage(error) };
  }

  revalidatePath("/account");
  revalidatePath("/account/membership");
  revalidatePath("/membership");
  redirect("/account/membership?started=1");
}

export async function acceptMembershipRulesAction(formData: FormData) {
  const viewer = await getOptionalViewer();
  if (!viewer) redirect("/login?next=/membership");
  const parsed = z.object({
    planId: z.string().trim().min(1).max(191),
    campaignId: z.string().trim().min(1).max(191),
    rulesAccepted: z.literal(true),
  }).safeParse({
    planId: formData.get("planId"),
    campaignId: formData.get("campaignId"),
    rulesAccepted: formData.get("rulesAccepted") === "on",
  });
  if (!parsed.success) redirect("/membership?error=rules-acceptance");
  const now = new Date();
  const [entrant, campaign] = await Promise.all([
    db.entrant.findFirst({
      where: { tenantId: viewer.tenantId, userId: viewer.userId },
      select: { id: true },
    }),
    db.campaign.findFirst({
      where: {
        id: parsed.data.campaignId,
        tenantId: viewer.tenantId,
        status: "LIVE",
        startsAt: { lte: now },
        endsAt: { gt: now },
        membershipBands: { some: { planId: parsed.data.planId } },
      },
      select: { id: true },
    }),
  ]);
  if (!entrant || !campaign) redirect("/membership?error=rules-acceptance");
  try {
    await acceptMembershipCampaignRules({
      tenantId: viewer.tenantId,
      campaignId: campaign.id,
      entrantId: entrant.id,
      userId: viewer.userId,
    });
  } catch {
    redirect("/membership?error=rules-acceptance");
  }
  revalidatePath("/membership");
  revalidatePath("/account/membership");
  redirect("/membership?rules-accepted=1");
}

export async function cancelMembershipAction(formData: FormData) {
  const viewer = await getOptionalViewer();
  if (!viewer) redirect("/login?next=/account/membership");

  const subscriptionId = String(formData.get("subscriptionId") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  if (!subscriptionId || idempotencyKey.length < 8) redirect("/account/membership?error=invalid");

  const owned = await db.subscription.findFirst({
    where: { id: subscriptionId, tenantId: viewer.tenantId, userId: viewer.userId },
    select: { id: true },
  });
  if (!owned) redirect("/account/membership?error=not-found");

  if (process.env.DEMO_MODE !== "true") {
    try {
      const trustedIp = await getTrustedClientIp();
      const limit = await consumeRateLimits({
        tenantId: viewer.tenantId,
        rules: publicRateLimitRules({
          scope: "membership-billing-portal",
          subject: viewer.userId,
          subjectLimit: 10,
          ip: trustedIp,
          ipLimit: 50,
          windowSeconds: 15 * 60,
        }),
      });
      if (!limit.allowed) redirect("/account/membership?error=rate-limit");
      const portal = await createStripeBillingPortal({
        tenantId: viewer.tenantId,
        subscriptionId: owned.id,
        userId: viewer.userId,
        idempotencyKey,
      });
      redirect(portal.redirectUrl as Route);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      redirect("/account/membership?error=portal");
    }
  }

  try {
    await cancelSubscriptionAtPeriodEnd({
      tenantId: viewer.tenantId,
      subscriptionId: owned.id,
      idempotencyKey,
    });
  } catch {
    redirect("/account/membership?error=cancel");
  }

  revalidatePath("/account/membership");
  revalidatePath("/membership");
  redirect("/account/membership?cancelled=1");
}
