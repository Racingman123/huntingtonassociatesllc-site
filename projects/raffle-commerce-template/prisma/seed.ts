import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { defaultTheme } from "../src/theme/default-theme";
import { calculateEntries } from "../src/lib/entries";
import { resolvePurchaseEntryRules } from "../src/lib/purchase-entry-rules";
import {
  campaignReleaseManifestJson,
  readCampaignReleaseManifest,
} from "../src/server/campaigns/integrity";

const prisma = new PrismaClient();

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

const officialRules = `# Official Rules — Northstar Adventure Rig Sweepstakes

NO PURCHASE NECESSARY. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING.

## 1. Sponsor and administrator

The demo sponsor is Northstar Supply Co. This template content is an implementation example and is not legal advice. Replace the sponsor identity, administrator, dates, jurisdictions, prize details, and all other terms with promotion-specific rules approved by qualified counsel before launch.

## 2. Eligibility

Open only to legal residents of the 48 contiguous United States and the District of Columbia who are at least 18 years old and the age of majority in their jurisdiction at entry, hold any license required to accept the vehicle prize, and satisfy the complete eligibility policy. Employees, officers, directors, agencies, household members, and persons otherwise excluded in the approved policy are not eligible. Void where prohibited.

## 3. Promotion period

The promotion begins and ends at the exact Eastern Time instants displayed on the campaign page. The server timestamp controls. Free online entry remains available through the separate free-entry deadline displayed there.

## 4. How to enter

### Purchase entry

Eligible merchandise purchases earn entries on whole qualifying currency units after discounts and before tax and shipping. The product page and cart show the exact entry quote before checkout. Entries are posted only after payment is confirmed. Returns, refunds, disputes, and chargebacks may reverse the entries attributable to the affected merchandise as described in these rules.

### Free alternative method of entry

Use the direct Free Entry page without making a purchase or consenting to marketing. Each valid submission earns 25,000 entries. The online form accepts one submission per normalized email per campaign-calendar day until the free-entry deadline; the administrator separately reviews natural-person duplicates under the published eligibility policy. Purchase and free entries share the same 1,000,000-entry per-person cap, entry pool, odds, and prize. A purchase does not improve the odds beyond the number of entries earned, and the free method can reach the same cap.

Automated, scripted, duplicate, incomplete, or false submissions are void, subject to documented human review. Shared devices, IP addresses, or households are not by themselves grounds for disqualification.

## 5. Prize

One winner will receive the adventure vehicle and cash package described on the campaign page. Approximate retail values, restrictions, delivery conditions, taxes, title, registration, insurance, and any permitted cash alternative must be listed in the final approved prize schedule.

## 6. Odds and winner selection

Odds depend on the number of eligible entries. After entry closes and reconciliation finishes, the administrator will seal the eligible-entry snapshot and conduct a random drawing using the approved procedure. The selected entrant is only a provisional winner until identity and eligibility are verified. Ordered alternates may be contacted if the selected entrant is ineligible, declines, or does not respond by the stated deadline.

## 7. Notification and claims

Potential winners are contacted by the administrator using the email and telephone information supplied at entry. Northstar will never require payment, gift cards, banking credentials, or social-media direct messages to release a prize. Eligibility documents and tax forms are collected only through the secure winner-claim process.

## 8. Privacy, publicity, and winner list

Entry data is used to administer the promotion as described in the Privacy Notice. Marketing consent is separate and optional. Only the minimum approved winner information is published. Any publicity release is subject to applicable law and collected after selection.

## 9. General conditions

The sponsor may address fraud, technical failure, or events impairing integrity only under the approved rules, with a documented audit trail and any required regulator approval. The sponsor may not arbitrarily reject entries, change material rules after launch, or manually choose a winner.
`;

const privacyNotice = `# Privacy Notice

This template demonstrates a privacy-minimizing sweepstakes storefront. At entry we collect the information needed to determine eligibility, administer entries, prevent abuse, contact a potential winner, and comply with law. Marketing email and SMS consent are optional, separate, and never affect entry or odds.

We retain promotion records for the period required by the applicable rules and law, then delete or de-identify information that is no longer needed. Identity, tax, and prize-claim documents should be collected only from provisional winners through a secure administrator. Requests to access, correct, delete, or export personal information can be sent to the configured privacy contact. Legal retention obligations may limit deletion.

Before production use, replace this example with a jurisdiction-specific notice identifying the sponsor/controller, data categories, purposes, processors, retention schedule, consumer rights, appeal process, cross-border transfers, and contact information.
`;

const terms = `# Website Terms

These example terms govern use of the demo storefront. Product purchases and promotional entries are separate transactions. The Official Rules control the sweepstakes. Nothing in these template terms creates a paid lottery, guarantees that a visitor will win, or authorizes a promotion where prohibited.

Replace this content with counsel-approved terms covering the merchant identity, acceptable use, accounts, orders, intellectual property, warranties, limitations, disputes, and applicable consumer rights.
`;

const refunds = `# Shipping and Returns

Demo orders are not fulfilled. In a live store, publish accurate processing, shipping, return, exchange, and refund terms. The checkout and refund UI must show the entry consequence of a return before confirmation. Entry reversals use the calculation recorded with the original order; they are never recalculated using a later multiplier.
`;

const productSeed = [
  {
    slug: "fast-pass-bronze",
    title: "Fast Pass Bronze",
    subtitle: "The quickest way to gear up",
    description: "A digital supporter pack with a limited wallpaper set, member badge, and 500X promotional entry rate.",
    productType: "DIGITAL",
    category: "Quick Entry",
    priceCents: 4900,
    compareAtCents: null,
    image: "/demo/products/pass-bronze.svg",
    secondaryImage: null,
    badge: null,
    // The category EntryRule supplies the 2× boost. Keep the catalog factor at
    // one so the same business multiplier is not applied twice.
    entryMultiplier: 1,
    featured: true,
    inventory: 9999,
    tagsJson: JSON.stringify(["quick-entry", "digital"]),
  },
  {
    slug: "fast-pass-gold",
    title: "Fast Pass Gold",
    subtitle: "Most popular",
    description: "A larger digital supporter pack with exclusive desktop art, mobile wallpapers, and a 500X promotional entry rate.",
    productType: "DIGITAL",
    category: "Quick Entry",
    priceCents: 9900,
    compareAtCents: null,
    image: "/demo/products/pass-gold.svg",
    secondaryImage: null,
    badge: "MOST POPULAR",
    entryMultiplier: 1,
    featured: true,
    inventory: 9999,
    tagsJson: JSON.stringify(["quick-entry", "digital"]),
  },
  {
    slug: "fast-pass-black",
    title: "Fast Pass Black",
    subtitle: "Maximum momentum",
    description: "The premium digital supporter pack with a complete art archive and a 500X promotional entry rate.",
    productType: "DIGITAL",
    category: "Quick Entry",
    priceCents: 24900,
    compareAtCents: null,
    image: "/demo/products/pass-black.svg",
    secondaryImage: null,
    badge: "BEST VALUE",
    entryMultiplier: 1,
    featured: true,
    inventory: 9999,
    tagsJson: JSON.stringify(["quick-entry", "digital"]),
  },
  {
    slug: "summit-roadside-kit",
    title: "Summit Roadside Kit",
    subtitle: "Built for the unexpected",
    description: "A compact roadside kit with jump leads, recovery strap, work light, first-aid pouch, and weatherproof carry case.",
    productType: "PHYSICAL",
    category: "Gear",
    priceCents: 15900,
    compareAtCents: 19900,
    image: "/demo/products/roadside-kit.svg",
    secondaryImage: "/demo/products/roadside-kit-alt.svg",
    badge: "LIMITED",
    entryMultiplier: 1,
    featured: true,
    inventory: 84,
    tagsJson: JSON.stringify(["gear", "outdoors"]),
  },
  {
    slug: "ridge-tactical-wallet",
    title: "Ridge Tactical Wallet",
    subtitle: "Aircraft-grade aluminum",
    description: "A low-profile RFID-blocking wallet with an anodized alloy chassis, elastic retention, and removable money clip.",
    productType: "PHYSICAL",
    category: "Accessories",
    priceCents: 7900,
    compareAtCents: 9900,
    image: "/demo/products/wallet.svg",
    secondaryImage: "/demo/products/wallet-alt.svg",
    badge: null,
    entryMultiplier: 1,
    featured: true,
    inventory: 240,
    tagsJson: JSON.stringify(["wallet", "everyday-carry"]),
  },
  {
    slug: "trail-beam-flashlight",
    title: "Trail Beam Flashlight",
    subtitle: "2,000-lumen rechargeable light",
    description: "A pocketable weather-resistant light with five modes, USB-C charging, and magnetic tail cap.",
    productType: "PHYSICAL",
    category: "Gear",
    priceCents: 7500,
    compareAtCents: null,
    image: "/demo/products/flashlight.svg",
    secondaryImage: null,
    badge: "NEW",
    entryMultiplier: 1,
    featured: true,
    inventory: 160,
    tagsJson: JSON.stringify(["gear", "lighting"]),
  },
  {
    slug: "northstar-heavyweight-tee",
    title: "Northstar Heavyweight Tee",
    subtitle: "Garment dyed / relaxed fit",
    description: "A heavyweight cotton tee with a soft garment wash, reinforced collar, and understated trail-mark graphic.",
    productType: "PHYSICAL",
    category: "Apparel",
    priceCents: 5500,
    compareAtCents: null,
    image: "/demo/products/tee.svg",
    secondaryImage: "/demo/products/tee-alt.svg",
    badge: null,
    entryMultiplier: 1,
    featured: true,
    inventory: 220,
    tagsJson: JSON.stringify(["apparel", "tee"]),
  },
  {
    slug: "switchback-trucker-hat",
    title: "Switchback Trucker Hat",
    subtitle: "High crown / snapback",
    description: "A structured six-panel trucker hat with breathable mesh and a woven Northstar trail patch.",
    productType: "PHYSICAL",
    category: "Headwear",
    priceCents: 3800,
    compareAtCents: null,
    image: "/demo/products/hat.svg",
    secondaryImage: null,
    badge: null,
    entryMultiplier: 1,
    featured: false,
    inventory: 120,
    tagsJson: JSON.stringify(["apparel", "headwear"]),
  },
  {
    slug: "overland-collector-print",
    title: "Overland Collector Print",
    subtitle: "Numbered 18 × 24 edition",
    description: "A museum-grade archival print celebrating the current adventure-rig build, individually numbered and shipped flat.",
    productType: "PHYSICAL",
    category: "Wall Art",
    priceCents: 12900,
    compareAtCents: null,
    image: "/demo/products/print.svg",
    secondaryImage: null,
    badge: "NUMBERED",
    entryMultiplier: 1,
    featured: true,
    inventory: 100,
    tagsJson: JSON.stringify(["art", "limited"]),
  },
  {
    slug: "basecamp-membership",
    title: "Basecamp Membership",
    subtitle: "Monthly member pack",
    description: "A monthly store-credit and member-perk plan. Renewal entry awards are generated as separate paid orders and always follow the active rules.",
    productType: "MEMBERSHIP",
    category: "Membership",
    priceCents: 2500,
    compareAtCents: null,
    image: "/demo/products/membership.svg",
    secondaryImage: null,
    badge: "MEMBERS",
    entryMultiplier: 1,
    featured: false,
    inventory: 9999,
    tagsJson: JSON.stringify(["membership"]),
  },
] as const;

async function createPastWinner(input: {
  tenantId: string;
  index: number;
  code: string;
  campaignTitle: string;
  prizeName: string;
  winnerName: string;
  location: string;
  quote: string;
}) {
  const end = daysFromNow(-45 - input.index * 70);
  const start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
  const rules = await prisma.legalDocument.findFirstOrThrow({
    where: { tenantId: input.tenantId, kind: "OFFICIAL_RULES", status: "PUBLISHED" },
    orderBy: { version: "desc" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      tenantId: input.tenantId,
      slug: input.code.toLowerCase(),
      code: input.code,
      title: input.campaignTitle,
      shortDescription: input.prizeName,
      longDescription: `The completed ${input.code} demonstration campaign.`,
      status: "COMPLETED",
      startsAt: start,
      endsAt: end,
      freeEntryEndsAt: end,
      drawAt: new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000),
      baseEntriesPerDollar: 1,
      currentMultiplier: 100,
      maxEntriesPerEntrant: 1_000_000n,
      eligibilitySummary: "Demo: eligible U.S. residents age 18+; void where prohibited.",
      rulesVersion: rules.version,
      officialRulesDocumentId: rules.id,
      officialRulesChecksum: rules.checksum,
      configChecksum: sha256(`${input.code}:${start.toISOString()}:${end.toISOString()}`),
      approvedAt: null,
    },
  });
  const prize = await prisma.campaignPrize.create({
    data: {
      tenantId: input.tenantId,
      campaignId: campaign.id,
      name: input.prizeName,
      description: input.prizeName,
      approximateValueCents: 12500000 + input.index * 1000000,
      image: `/demo/winners/winner-${input.index}.svg`,
    },
  });
  const entrant = await prisma.entrant.create({
    data: {
      tenantId: input.tenantId,
      normalizedEmail: `winner${input.index}@example.test`,
      emailHash: sha256(`winner${input.index}@example.test`),
      name: input.winnerName,
      phone: `+13035550${String(140 + input.index).padStart(3, "0")}`,
      region: input.location.split(", ").at(-1),
      eligibilityAttested: true,
    },
  });
  await prisma.campaignEntrant.create({
    data: { campaignId: campaign.id, entrantId: entrant.id, status: "VERIFIED" },
  });
  const account = await prisma.entryAccount.create({
    data: {
      tenantId: input.tenantId,
      campaignId: campaign.id,
      entrantId: entrant.id,
      balance: BigInt(125000 + input.index * 10000),
    },
  });
  const snapshot = await prisma.entrySnapshot.create({
    data: {
      tenantId: input.tenantId,
      campaignId: campaign.id,
      version: 1,
      status: "DRAFT",
      cutoffAt: end,
      ledgerHighWaterAt: end,
      totalEntries: account.balance,
      entrantCount: 1,
      checksum: sha256(`${campaign.id}:${account.id}:${account.balance}`),
      rows: {
        create: {
          entryAccountId: account.id,
          entryCount: account.balance,
          rangeStart: 1n,
          rangeEnd: account.balance,
        },
      },
      approvals: {
        create: [
          { kind: "OPERATIONS_RECONCILIATION", status: "PENDING" },
          { kind: "COMPLIANCE_WITNESS", status: "PENDING" },
        ],
      },
    },
  });
  await prisma.entrySnapshot.update({
    where: { id: snapshot.id },
    data: { status: "AWAITING_APPROVAL" },
  });
  const historicalApprovalTime = new Date(end.getTime() + 6 * 24 * 60 * 60 * 1000);
  await prisma.snapshotApproval.updateMany({
    where: { snapshotId: snapshot.id, kind: "OPERATIONS_RECONCILIATION" },
    data: {
      status: "APPROVED",
      approverId: "independent-demo-administrator",
      notes: "Historical demo reconciliation approval.",
      decidedAt: historicalApprovalTime,
    },
  });
  await prisma.snapshotApproval.updateMany({
    where: { snapshotId: snapshot.id, kind: "COMPLIANCE_WITNESS" },
    data: {
      status: "APPROVED",
      approverId: "independent-demo-witness",
      notes: "Historical demo compliance approval.",
      decidedAt: historicalApprovalTime,
    },
  });
  await prisma.entrySnapshot.update({
    where: { id: snapshot.id },
    data: {
      status: "SEALED",
      sealedAt: historicalApprovalTime,
      sealedBy: "independent-demo-administrator",
    },
  });
  const draw = await prisma.draw.create({
    data: {
      tenantId: input.tenantId,
      campaignId: campaign.id,
      snapshotId: snapshot.id,
      status: "DRAFT",
      provider: "INDEPENDENT_DEMO",
      seedHash: sha256(`seed:${campaign.id}`),
      resultChecksum: sha256(`result:${campaign.id}:${account.id}`),
      operatorId: "demo-administrator",
      witnessId: "demo-witness",
      conductedAt: new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  const candidate = await prisma.drawCandidate.create({
    data: {
      drawId: draw.id,
      entryAccountId: account.id,
      rank: 1,
      selectedEntry: BigInt(50000 + input.index * 1000),
      status: "VERIFIED",
      verifiedAt: new Date(end.getTime() + 10 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.draw.update({ where: { id: draw.id }, data: { status: "CLOSED" } });
  await prisma.winner.create({
    data: {
      tenantId: input.tenantId,
      campaignId: campaign.id,
      prizeId: prize.id,
      entrantId: entrant.id,
      drawCandidateId: candidate.id,
      slug: `${input.code.toLowerCase()}-${input.winnerName.toLowerCase().replaceAll(" ", "-")}`,
      status: "PUBLISHED",
      publicName: input.winnerName,
      publicLocation: input.location,
      quote: input.quote,
      image: `/demo/winners/winner-${input.index}.svg`,
      verifiedAt: candidate.verifiedAt,
      publishedAt: new Date(end.getTime() + 12 * 24 * 60 * 60 * 1000),
      fulfilledAt: new Date(end.getTime() + 25 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { approvedAt: new Date(start.getTime() - 10 * 24 * 60 * 60 * 1000) },
  });
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The fictional demo seed is disabled when NODE_ENV=production");
  }
  const existing = await prisma.tenant.findUnique({ where: { slug: "northstar" } });
  if (existing) {
    console.log("Seed already present; skipping.");
    return;
  }

  const tenant = await prisma.tenant.create({
    data: {
      slug: "northstar",
      displayName: defaultTheme.brand.displayName,
      legalName: "Northstar Supply Co. Demo LLC",
      supportEmail: "support@example.com",
      primaryDomain: "localhost",
    },
  });

  const themeJson = JSON.stringify(defaultTheme);
  await prisma.themeVersion.create({
    data: {
      tenantId: tenant.id,
      version: 1,
      status: "PUBLISHED",
      name: "Northstar Launch",
      configJson: themeJson,
      checksum: sha256(themeJson),
      publishedAt: new Date(),
    },
  });

  const [adminHash, customerHash, witnessHash] = await Promise.all([
    hash("DemoAdmin!234", 12),
    hash("DemoCustomer!234", 12),
    hash("DemoWitness!234", 12),
  ]);
  const administrator = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "admin@example.com",
      normalizedEmail: "admin@example.com",
      name: "Demo Administrator",
      passwordHash: adminHash,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
    },
  });
  const customer = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "alex@example.com",
      normalizedEmail: "alex@example.com",
      name: "Alex Morgan",
      passwordHash: customerHash,
      role: "CUSTOMER",
      emailVerifiedAt: new Date(),
    },
  });
  const witness = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "witness@example.com",
      normalizedEmail: "witness@example.com",
      name: "Demo Compliance Witness",
      passwordHash: witnessHash,
      role: "COMPLIANCE",
      emailVerifiedAt: new Date(),
    },
  });

  const campaignConfig = {
    code: "NS-025",
    startsAt: daysFromNow(-3).toISOString(),
    // A 45-day total window makes forty 25,000-entry daily AMOE awards
    // attainable from campaign launch, matching the shared 1,000,000 cap.
    endsAt: daysFromNow(42).toISOString(),
    freeEntryEndsAt: daysFromNow(42).toISOString(),
    baseEntriesPerDollar: 1,
    multiplier: 250,
    entryCap: "1000000",
    minimumAge: 18,
    eligibleCountries: ["US"],
    eligibleRegions: [
      "AL", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
      "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
      "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
      "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
      "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    ],
    excludedRegions: ["AK", "HI", "PR", "GU", "VI", "AS", "MP"],
  };
  const officialRulesDocument = await prisma.legalDocument.create({
    data: {
      tenantId: tenant.id,
      kind: "OFFICIAL_RULES",
      slug: "official-rules",
      title: "Official Rules",
      body: officialRules,
      version: 1,
      checksum: sha256(officialRules),
      status: "PUBLISHED",
      effectiveAt: new Date(campaignConfig.startsAt),
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      tenantId: tenant.id,
      slug: "adventure-rig",
      code: campaignConfig.code,
      title: "Win the Adventure Rig + $25,000",
      eyebrow: "THE NORTHSTAR GIVEAWAY",
      shortDescription: "A fully built overland truck, a trail-ready camper, and $25,000 cash.",
      longDescription: "One verified winner takes home our most capable adventure build yet: a new heavy-duty 4×4, premium slide-in camper, complete recovery setup, and cash for the first trip.",
      // Build the complete fictional release before approving it. The local
      // hardening layer intentionally forbids adding reviewed child evidence
      // or active catalog rows to an already approved/live campaign.
      status: "DRAFT",
      startsAt: new Date(campaignConfig.startsAt),
      endsAt: new Date(campaignConfig.endsAt),
      freeEntryEndsAt: new Date(campaignConfig.freeEntryEndsAt),
      drawAt: daysFromNow(45),
      baseEntriesPerDollar: campaignConfig.baseEntriesPerDollar,
      currentMultiplier: campaignConfig.multiplier,
      maxEntriesPerEntrant: BigInt(campaignConfig.entryCap),
      eligibilitySummary: "Open to legal residents of the 48 contiguous United States and D.C., age 18+ and age of majority. Void where prohibited.",
      minimumAge: campaignConfig.minimumAge,
      eligibleCountriesJson: JSON.stringify(campaignConfig.eligibleCountries),
      eligibleRegionsJson: JSON.stringify(campaignConfig.eligibleRegions),
      excludedRegionsJson: JSON.stringify(campaignConfig.excludedRegions),
      rulesVersion: officialRulesDocument.version,
      officialRulesDocumentId: officialRulesDocument.id,
      officialRulesChecksum: officialRulesDocument.checksum,
      configChecksum: sha256(JSON.stringify(campaignConfig)),
      approvedAt: null,
      prizes: {
        create: {
          tenantId: tenant.id,
          name: "Adventure Rig + $25,000",
          description: "A heavy-duty 4×4 with premium camper and $25,000 cash.",
          approximateValueCents: 18500000,
          cashAlternativeCents: 12500000,
          image: "/demo/giveaway/hero-rig.svg",
        },
      },
      entryRules: {
        create: [
          {
            name: "Standard merchandise",
            ruleType: "MONEY_RATE",
            targetType: "ALL",
            entriesPerDollar: 1,
            multiplierNumerator: 1,
            stackPriority: 0,
          },
          {
            name: "Quick entry pass boost",
            ruleType: "MONEY_RATE",
            targetType: "CATEGORY",
            targetId: "Quick Entry",
            entriesPerDollar: 1,
            multiplierNumerator: 2,
            stackPriority: 10,
          },
          {
            name: "Free alternative entry",
            ruleType: "AMOE_FIXED",
            targetType: "FREE_ENTRY",
            baseEntries: 25000n,
            multiplierNumerator: 1,
            stackPriority: 100,
          },
        ],
      },
      multiplierSlots: {
        create: {
          label: "Launch 250X",
          numerator: 250,
          startsAt: new Date(campaignConfig.startsAt),
          endsAt: new Date(campaignConfig.endsAt),
        },
      },
    },
    include: { prizes: true, entryRules: true },
  });

  const createdProducts = [];
  for (const [index, item] of productSeed.entries()) {
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        ...item,
        variants: {
          create: item.category === "Apparel"
            ? ["S", "M", "L", "XL", "2XL"].map((size) => ({
                tenantId: tenant.id,
                sku: `NS-${String(index + 1).padStart(3, "0")}-${size}`,
                title: size,
                optionJson: JSON.stringify({ size }),
                inventory: 44,
              }))
            : {
                tenantId: tenant.id,
                sku: `NS-${String(index + 1).padStart(3, "0")}-DEFAULT`,
                title: "Default",
                inventory: item.inventory,
              },
        },
      },
      include: { variants: true },
    });
    createdProducts.push(product);
  }

  const collectionSeed = [
    { slug: "new-releases", title: "New Releases", description: "Fresh gear and limited campaign drops.", image: "/demo/categories/new.svg" },
    { slug: "quick-entry", title: "Quick Entry", description: "Digital supporter packs for visitors short on time.", image: "/demo/categories/quick.svg" },
    { slug: "gear", title: "Gear", description: "Trail-tested equipment for road and camp.", image: "/demo/categories/gear.svg" },
    { slug: "apparel", title: "Apparel", description: "Everyday layers built to last.", image: "/demo/categories/apparel.svg" },
  ];
  for (const [collectionIndex, item] of collectionSeed.entries()) {
    const collection = await prisma.collection.create({
      data: { tenantId: tenant.id, ...item, sortOrder: collectionIndex },
    });
    const selected = createdProducts.filter((product) => {
      if (item.slug === "new-releases") return product.featured;
      if (item.slug === "quick-entry") return product.category === "Quick Entry";
      if (item.slug === "gear") return ["Gear", "Accessories", "Wall Art"].includes(product.category);
      return ["Apparel", "Headwear"].includes(product.category);
    });
    await prisma.productCollection.createMany({
      data: selected.map((product, productIndex) => ({
        productId: product.id,
        collectionId: collection.id,
        sortOrder: productIndex,
      })),
    });
  }

  const membershipProduct = createdProducts.find((product) => product.slug === "basecamp-membership")!;
  const membershipPlan = await prisma.subscriptionPlan.create({
    data: {
      tenantId: tenant.id,
      productId: membershipProduct.id,
      name: "Basecamp Monthly",
      interval: "MONTH",
      intervalCount: 1,
      priceCents: membershipProduct.priceCents,
      baseEntries: 25n,
      providerPriceId: process.env.STRIPE_MEMBERSHIP_PRICE_ID?.trim() || null,
    },
  });
  await prisma.membershipEntryBand.createMany({
    data: [
      { campaignId: campaign.id, planId: membershipPlan.id, minimumSettledCycles: 0, maximumSettledCycles: 2, fixedEntries: 25n, multiplierNumerator: 1 },
      { campaignId: campaign.id, planId: membershipPlan.id, minimumSettledCycles: 3, maximumSettledCycles: 5, fixedEntries: 30n, multiplierNumerator: 1 },
      { campaignId: campaign.id, planId: membershipPlan.id, minimumSettledCycles: 6, fixedEntries: 40n, multiplierNumerator: 1 },
    ],
  });

  const legalDocs = [officialRulesDocument];
  for (const document of [
    { kind: "PRIVACY", slug: "privacy", title: "Privacy Notice", body: privacyNotice },
    { kind: "TERMS", slug: "terms", title: "Website Terms", body: terms },
    { kind: "RETURNS", slug: "shipping-returns", title: "Shipping and Returns", body: refunds },
  ]) {
    legalDocs.push(await prisma.legalDocument.create({
      data: {
        tenantId: tenant.id,
        ...document,
        version: 1,
        checksum: sha256(document.body),
        status: "PUBLISHED",
        effectiveAt: new Date(),
      },
    }));
  }

  const entrant = await prisma.entrant.create({
    data: {
      tenantId: tenant.id,
      userId: customer.id,
      normalizedEmail: customer.normalizedEmail,
      emailHash: sha256(customer.normalizedEmail),
      name: customer.name,
      phone: "+13035550148",
      region: "CO",
      postalCode: "80202",
      eligibilityAttested: true,
    },
  });
  await prisma.campaignEntrant.create({
    data: { campaignId: campaign.id, entrantId: entrant.id, status: "ELIGIBLE" },
  });
  const account = await prisma.entryAccount.create({
    data: { tenantId: tenant.id, campaignId: campaign.id, entrantId: entrant.id },
  });

  const kit = createdProducts.find((product) => product.slug === "summit-roadside-kit")!;
  const pass = createdProducts.find((product) => product.slug === "fast-pass-bronze")!;
  const lineInputs = [
    { product: kit, quantity: 1 },
    { product: pass, quantity: 1 },
  ];
  const quoteAt = daysFromNow(-1);
  const calculations = lineInputs.map(({ product, quantity }) => {
    const variant = product.variants[0]!;
    const ruleResolution = resolvePurchaseEntryRules({
      at: quoteAt,
      campaignBaseEntriesPerCurrencyUnit: campaign.baseEntriesPerDollar,
      catalogProductMultiplier: product.entryMultiplier,
      campaignMultiplier: campaign.currentMultiplier,
      rules: campaign.entryRules,
      target: {
        productId: product.id,
        productSlug: product.slug,
        category: product.category,
        variantId: variant.id,
        variantSku: variant.sku,
      },
    });
    const calculation = calculateEntries({
      unitPriceCents: product.priceCents,
      quantity,
      baseEntriesPerDollar: campaign.baseEntriesPerDollar,
      productMultiplier: product.entryMultiplier,
      purchaseRuleMultiplier: ruleResolution.purchaseRuleMultiplier,
      campaignMultiplier: campaign.currentMultiplier,
    });
    return { calculation, ruleResolution };
  });
  const orderEntries = calculations.reduce((sum, item) => sum + item.calculation.finalEntries, 0n);
  const subtotal = lineInputs.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  const order = await prisma.order.create({
    data: {
      tenantId: tenant.id,
      campaignId: campaign.id,
      entrantId: entrant.id,
      userId: customer.id,
      orderNumber: "NS-1001",
      status: "CONFIRMED",
      paymentStatus: "CAPTURED",
      fulfillmentStatus: "FULFILLED",
      email: customer.email,
      customerName: customer.name,
      subtotalCents: subtotal,
      shippingCents: 1200,
      taxCents: 2012,
      totalCents: subtotal + 3212,
      entryTotal: orderEntries,
      shippingAddressJson: JSON.stringify({ city: "Denver", region: "CO", postalCode: "80202", country: "US", phone: "+13035550148" }),
      idempotencyKey: "seed-order-1001",
      paidAt: daysFromNow(-1),
    },
  });

  for (const [index, input] of lineInputs.entries()) {
    const { calculation, ruleResolution } = calculations[index]!;
    const variant = input.product.variants[0];
    const line = await prisma.orderLine.create({
      data: {
        orderId: order.id,
        productId: input.product.id,
        variantId: variant.id,
        productTitle: input.product.title,
        variantTitle: variant.title,
        sku: variant.sku,
        quantity: input.quantity,
        unitPriceCents: input.product.priceCents,
        qualifyingCents: calculation.qualifyingCents,
        entryMultiplier: ruleResolution.effectiveMultiplier,
        entries: calculation.finalEntries,
        entryCalculationJson: JSON.stringify({ ...calculation.snapshot, purchaseRuleResolution: ruleResolution.snapshot }),
      },
    });
    const entitlement = await prisma.entryEntitlement.create({
      data: {
        tenantId: tenant.id,
        entryAccountId: account.id,
        orderId: order.id,
        orderLineId: line.id,
        originType: "ORDER_LINE",
        originalEntries: calculation.finalEntries,
        calculationJson: JSON.stringify({ ...calculation.snapshot, purchaseRuleResolution: ruleResolution.snapshot }),
        campaignConfigHash: campaign.configChecksum,
        idempotencyKey: `seed-entitlement-${index}`,
        effectiveAt: order.paidAt!,
      },
    });
    await prisma.entryLedgerEvent.create({
      data: {
        tenantId: tenant.id,
        entryAccountId: account.id,
        entitlementId: entitlement.id,
        kind: "GRANT",
        delta: calculation.finalEntries,
        idempotencyKey: `seed-ledger-order-${index}`,
        effectiveAt: order.paidAt!,
        reasonCode: "PAYMENT_CAPTURED",
        metadataJson: JSON.stringify({ orderNumber: order.orderNumber, lineId: line.id }),
      },
    });
  }

  const freeSubmission = await prisma.freeEntrySubmission.create({
    data: {
      tenantId: tenant.id,
      campaignId: campaign.id,
      entrantId: entrant.id,
      status: "APPROVED",
      entriesRequested: 25000n,
      confirmationCode: "FREE-DEMO-2026",
      rulesVersion: 1,
      eligibilityJson: JSON.stringify({ ageConfirmed: true, residenceConfirmed: true, rulesAccepted: true }),
      fingerprintHash: sha256("seed-free-entry"),
      submittedAt: daysFromNow(-2),
      reviewedAt: daysFromNow(-1),
      reviewedBy: "demo-administrator",
    },
  });
  const freeEntitlement = await prisma.entryEntitlement.create({
    data: {
      tenantId: tenant.id,
      entryAccountId: account.id,
      freeEntrySubmissionId: freeSubmission.id,
      originType: "FREE_ENTRY",
      originalEntries: 25000n,
      calculationJson: JSON.stringify({ schemaVersion: 1, method: "ONLINE_AMOE", fixedEntries: "25000" }),
      campaignConfigHash: campaign.configChecksum,
      idempotencyKey: "seed-free-entitlement",
      effectiveAt: freeSubmission.submittedAt,
    },
  });
  await prisma.entryLedgerEvent.create({
    data: {
      tenantId: tenant.id,
      entryAccountId: account.id,
      entitlementId: freeEntitlement.id,
      kind: "GRANT",
      delta: 25000n,
      idempotencyKey: "seed-ledger-free-entry",
      effectiveAt: freeSubmission.submittedAt,
      actorType: "ADMIN",
      actorId: "demo-administrator",
      reasonCode: "AMOE_APPROVED",
      metadataJson: JSON.stringify({ confirmationCode: freeSubmission.confirmationCode }),
    },
  });
  await prisma.entryAccount.update({
    where: { id: account.id },
    data: { balance: orderEntries + 25000n, version: { increment: 1 } },
  });
  await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: "DEMO",
      providerEventId: "seed-payment-event",
      providerPaymentId: "demo_payment_1001",
      status: "CAPTURED",
      amountCents: order.totalCents,
      currency: "USD",
      payloadHash: sha256("seed-payment-payload"),
      idempotencyKey: "seed-payment-event",
      processedAt: order.paidAt,
    },
  });

  const rulesDoc = legalDocs.find((document) => document.kind === "OFFICIAL_RULES")!;
  await prisma.rulesAcceptance.create({
    data: {
      tenantId: tenant.id,
      campaignId: campaign.id,
      entrantId: entrant.id,
      legalDocumentId: rulesDoc.id,
      documentChecksum: rulesDoc.checksum,
      method: "CHECKOUT",
      acceptedAt: order.createdAt,
    },
  });

  await prisma.campaignApproval.createMany({
    data: [
      "SPONSOR_ADMIN_PUBLICATION",
      "COMPLIANCE_WITNESS_PUBLICATION",
      "LEGAL_RULES",
      "PRIZE_FUNDING",
      "AMOE_PARITY",
      "DRAW_PROCEDURE",
      "ACCESSIBILITY",
    ].map((kind) => ({
      tenantId: tenant.id,
      campaignId: campaign.id,
      kind,
      status: "APPROVED",
      configChecksum: campaign.configChecksum,
      rulesChecksum: rulesDoc.checksum,
      approverId: kind === "SPONSOR_ADMIN_PUBLICATION" || kind === "PRIZE_FUNDING"
        ? administrator.id
        : witness.id,
      notes: "Demonstration approval only. A production campaign requires evidence and qualified reviewer signoff.",
      evidenceRef: `demo://campaign-approvals/${kind.toLowerCase()}`,
      decidedAt: daysFromNow(-16),
    })),
  });
  await prisma.filingRequirement.createMany({
    data: [
      {
        tenantId: tenant.id,
        campaignId: campaign.id,
        jurisdiction: "FL",
        kind: "REGISTRATION_AND_BOND",
        triggerReason: "Aggregate announced prize value exceeds $5,000.",
        dueAt: daysFromNow(-10),
        status: "COMPLETED",
        evidenceRef: "demo://filings/fl-receipt",
        approvedBy: "demo-legal-reviewer",
        completedAt: daysFromNow(-18),
      },
      {
        tenantId: tenant.id,
        campaignId: campaign.id,
        jurisdiction: "NY",
        kind: "REGISTRATION_AND_BOND",
        triggerReason: "Aggregate announced prize value exceeds $5,000.",
        dueAt: daysFromNow(-33),
        status: "COMPLETED",
        evidenceRef: "demo://filings/ny-receipt",
        approvedBy: "demo-legal-reviewer",
        completedAt: daysFromNow(-36),
      },
      {
        tenantId: tenant.id,
        campaignId: campaign.id,
        jurisdiction: "RI",
        kind: "RETAIL_GAME_FILING_REVIEW",
        triggerReason: "Retail-establishment promotion threshold review.",
        status: "NOT_APPLICABLE",
        waiverRationale: "Demo is not conducted through a Rhode Island retail establishment; production counsel must confirm.",
        approvedBy: "demo-legal-reviewer",
        completedAt: daysFromNow(-18),
      },
    ],
  });

  const seededRelease = await readCampaignReleaseManifest(prisma, campaign.id);
  await prisma.campaignApproval.updateMany({
    where: { campaignId: campaign.id },
    data: { configChecksum: seededRelease.checksum },
  });
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status: "LIVE",
      configChecksum: seededRelease.checksum,
      releaseManifestJson: campaignReleaseManifestJson(seededRelease.manifest),
      approvedAt: daysFromNow(-15),
    },
  });
  await prisma.entryEntitlement.updateMany({
    where: { account: { campaignId: campaign.id } },
    data: { campaignConfigHash: seededRelease.checksum },
  });

  await createPastWinner({
    tenantId: tenant.id,
    index: 1,
    code: "NS-024",
    campaignTitle: "The High Country Giveaway",
    prizeName: "High Country 4×4 + $15,000",
    winnerName: "Jordan Ellis",
    location: "Boise, ID",
    quote: "I entered because I needed a new trail shirt. I never expected the phone call that followed.",
  });
  await createPastWinner({
    tenantId: tenant.id,
    index: 2,
    code: "NS-023",
    campaignTitle: "The Weekender Giveaway",
    prizeName: "Weekender Van + $10,000",
    winnerName: "Taylor Brooks",
    location: "Asheville, NC",
    quote: "The whole process was clear, professional, and honestly still feels unreal.",
  });
  await createPastWinner({
    tenantId: tenant.id,
    index: 3,
    code: "NS-022",
    campaignTitle: "The Backcountry Giveaway",
    prizeName: "Backcountry SUV + $20,000",
    winnerName: "Casey Nguyen",
    location: "Flagstaff, AZ",
    quote: "We picked it up, packed the camping gear, and put it to work the same weekend.",
  });

  await prisma.auditEvent.createMany({
    data: [
      {
        tenantId: tenant.id,
        actorType: "SYSTEM",
        action: "CAMPAIGN_PUBLISHED",
        resourceType: "Campaign",
        resourceId: campaign.id,
        metadataJson: JSON.stringify({ checksum: seededRelease.checksum }),
      },
      {
        tenantId: tenant.id,
        actorType: "SYSTEM",
        action: "THEME_PUBLISHED",
        resourceType: "ThemeVersion",
        metadataJson: JSON.stringify({ checksum: sha256(themeJson) }),
      },
    ],
  });

  console.log("Seed complete.");
  console.log("Admin: admin@example.com / DemoAdmin!234");
  console.log("Customer: alex@example.com / DemoCustomer!234");
  console.log("Compliance witness: witness@example.com / DemoWitness!234");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
