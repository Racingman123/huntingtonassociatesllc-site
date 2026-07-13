import { describe, expect, it } from "vitest";
import { assertCampaignTransition, canTransitionCampaign } from "./lifecycle";

describe("campaign lifecycle", () => {
  it("allows the normal reviewed launch path", () => {
    expect(canTransitionCampaign("DRAFT", "IN_REVIEW")).toBe(true);
    expect(canTransitionCampaign("IN_REVIEW", "APPROVED")).toBe(true);
    expect(canTransitionCampaign("APPROVED", "SCHEDULED")).toBe(true);
    expect(canTransitionCampaign("SCHEDULED", "LIVE")).toBe(true);
  });

  it("blocks skipping reconciliation and winner verification", () => {
    expect(canTransitionCampaign("LIVE", "SEALED")).toBe(false);
    expect(canTransitionCampaign("SNAPSHOT_REVIEW", "SEALED")).toBe(true);
    expect(canTransitionCampaign("SEALED", "WINNER_PENDING")).toBe(true);
    expect(() => assertCampaignTransition("SEALED", "COMPLETED")).toThrow(/cannot transition/);
  });
});
