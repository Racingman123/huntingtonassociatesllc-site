-- Development/demo defense-in-depth. Production PostgreSQL deployments should
-- recreate these invariants with a restricted runtime role and reviewed SQL
-- migrations. Prisma's application layer still validates every operation.

CREATE TRIGGER IF NOT EXISTS entry_ledger_delta_nonzero
BEFORE INSERT ON EntryLedgerEvent
WHEN NEW.delta = 0
BEGIN
  SELECT RAISE(ABORT, 'entry ledger delta must be nonzero');
END;

CREATE TRIGGER IF NOT EXISTS entry_ledger_no_post_seal_insert
BEFORE INSERT ON EntryLedgerEvent
WHEN EXISTS (
  SELECT 1
  FROM EntryAccount account
  JOIN EntrySnapshot snapshot ON snapshot.campaignId = account.campaignId
  WHERE account.id = NEW.entryAccountId AND snapshot.status = 'SEALED'
)
BEGIN
  SELECT RAISE(ABORT, 'entry ledger is sealed; use an approved post-seal case');
END;

CREATE TRIGGER IF NOT EXISTS entry_ledger_no_frozen_campaign_insert
BEFORE INSERT ON EntryLedgerEvent
WHEN EXISTS (
  SELECT 1
  FROM EntryAccount account
  JOIN Campaign campaign ON campaign.id = account.campaignId
  WHERE account.id = NEW.entryAccountId AND campaign.status IN (
    'SNAPSHOT_REVIEW', 'SEALED', 'DRAW_IN_PROGRESS', 'WINNER_PENDING', 'COMPLETED', 'ARCHIVED'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'entry ledger is frozen for snapshot review or draw');
END;

CREATE TRIGGER IF NOT EXISTS entry_ledger_no_update
BEFORE UPDATE ON EntryLedgerEvent
BEGIN
  SELECT RAISE(ABORT, 'entry ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS entry_ledger_no_delete
BEFORE DELETE ON EntryLedgerEvent
BEGIN
  SELECT RAISE(ABORT, 'entry ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS entry_balance_nonnegative
BEFORE UPDATE OF balance ON EntryAccount
WHEN NEW.balance < 0
BEGIN
  SELECT RAISE(ABORT, 'entry balance cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS entry_account_no_frozen_population_update
BEFORE UPDATE OF tenantId, campaignId, entrantId, balance ON EntryAccount
WHEN (SELECT status FROM Campaign WHERE id = OLD.campaignId) IN (
  'SNAPSHOT_REVIEW', 'SEALED', 'DRAW_IN_PROGRESS', 'WINNER_PENDING', 'COMPLETED', 'ARCHIVED'
)
BEGIN
  SELECT RAISE(ABORT, 'entry account population is frozen for snapshot review or draw');
END;

CREATE TRIGGER IF NOT EXISTS entry_account_no_frozen_population_delete
BEFORE DELETE ON EntryAccount
WHEN (SELECT status FROM Campaign WHERE id = OLD.campaignId) IN (
  'SNAPSHOT_REVIEW', 'SEALED', 'DRAW_IN_PROGRESS', 'WINNER_PENDING', 'COMPLETED', 'ARCHIVED'
)
BEGIN
  SELECT RAISE(ABORT, 'entry account population is frozen for snapshot review or draw');
END;

CREATE TRIGGER IF NOT EXISTS variant_inventory_reservation_insert_valid
BEFORE INSERT ON ProductVariant
WHEN NEW.inventory < 0 OR NEW.reservedInventory < 0 OR NEW.reservedInventory > NEW.inventory
BEGIN
  SELECT RAISE(ABORT, 'variant inventory reservation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS variant_inventory_reservation_update_valid
BEFORE UPDATE OF inventory, reservedInventory ON ProductVariant
WHEN NEW.inventory < 0 OR NEW.reservedInventory < 0 OR NEW.reservedInventory > NEW.inventory
BEGIN
  SELECT RAISE(ABORT, 'variant inventory reservation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS audit_event_no_update
BEFORE UPDATE ON AuditEvent
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_event_no_delete
BEFORE DELETE ON AuditEvent
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS published_legal_document_no_update
BEFORE UPDATE ON LegalDocument
WHEN OLD.status = 'PUBLISHED'
BEGIN
  SELECT RAISE(ABORT, 'published legal documents are immutable; publish a new version');
END;

CREATE TRIGGER IF NOT EXISTS published_legal_document_no_delete
BEFORE DELETE ON LegalDocument
WHEN OLD.status = 'PUBLISHED'
BEGIN
  SELECT RAISE(ABORT, 'published legal documents are immutable; retain version history');
END;

CREATE TRIGGER IF NOT EXISTS campaign_official_rules_binding_no_update
BEFORE UPDATE OF officialRulesDocumentId, officialRulesChecksum, rulesVersion ON Campaign
WHEN OLD.officialRulesDocumentId IS NOT NULL
  AND (
    NEW.officialRulesDocumentId IS NOT OLD.officialRulesDocumentId
    OR NEW.officialRulesChecksum IS NOT OLD.officialRulesChecksum
    OR NEW.rulesVersion IS NOT OLD.rulesVersion
  )
BEGIN
  SELECT RAISE(ABORT, 'campaign Official Rules binding is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_release_no_config_update
BEFORE UPDATE OF tenantId, slug, code, title, eyebrow, shortDescription, longDescription, kind,
  timezone, startsAt, endsAt, freeEntryEndsAt, drawAt, baseEntriesPerDollar,
  currentMultiplier, maxEntriesPerEntrant, noPurchaseDisclosure, eligibilitySummary,
  minimumAge, eligibleCountriesJson, eligibleRegionsJson, excludedRegionsJson,
  rulesVersion, officialRulesDocumentId, officialRulesChecksum, configChecksum,
  releaseManifestJson, approvedAt
ON Campaign
WHEN OLD.approvedAt IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign release is immutable; publish a new campaign release');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_release_no_delete
BEFORE DELETE ON Campaign
WHEN OLD.approvedAt IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign release must be retained');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_prize_no_insert
BEFORE INSERT ON CampaignPrize
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign prizes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_prize_no_update
BEFORE UPDATE ON CampaignPrize
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign prizes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_prize_no_delete
BEFORE DELETE ON CampaignPrize
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign prizes are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_entry_rule_no_insert
BEFORE INSERT ON EntryRule
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign entry rules are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_entry_rule_no_update
BEFORE UPDATE ON EntryRule
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign entry rules are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_entry_rule_no_delete
BEFORE DELETE ON EntryRule
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign entry rules are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_multiplier_no_insert
BEFORE INSERT ON EntryMultiplierPeriod
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign multiplier schedule is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_multiplier_no_update
BEFORE UPDATE ON EntryMultiplierPeriod
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign multiplier schedule is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_multiplier_no_delete
BEFORE DELETE ON EntryMultiplierPeriod
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign multiplier schedule is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_membership_band_no_insert
BEFORE INSERT ON MembershipEntryBand
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership entry bands are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_membership_band_no_update
BEFORE UPDATE ON MembershipEntryBand
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership entry bands are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_membership_band_no_delete
BEFORE DELETE ON MembershipEntryBand
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership entry bands are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_approval_no_insert
BEFORE INSERT ON CampaignApproval
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_approval_no_update
BEFORE UPDATE ON CampaignApproval
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_approval_no_delete
BEFORE DELETE ON CampaignApproval
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_filing_no_insert
BEFORE INSERT ON FilingRequirement
WHEN (SELECT approvedAt FROM Campaign WHERE id = NEW.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign filing evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_filing_no_update
BEFORE UPDATE ON FilingRequirement
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign filing evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS approved_campaign_filing_no_delete
BEFORE DELETE ON FilingRequirement
WHEN (SELECT approvedAt FROM Campaign WHERE id = OLD.campaignId) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'approved campaign filing evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS frozen_snapshot_header_no_update
BEFORE UPDATE OF tenantId, campaignId, version, cutoffAt, ledgerHighWaterAt,
  totalEntries, entrantCount, checksum, createdAt
ON EntrySnapshot
WHEN OLD.status IN ('AWAITING_APPROVAL', 'SEALED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'approved snapshot header evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS frozen_snapshot_seal_evidence_no_update
BEFORE UPDATE OF sealedAt, sealedBy ON EntrySnapshot
WHEN OLD.status IN ('SEALED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'snapshot seal evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS frozen_snapshot_status_transition_valid
BEFORE UPDATE OF status ON EntrySnapshot
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'DRAFT' AND NEW.status = 'AWAITING_APPROVAL')
  OR (OLD.status = 'AWAITING_APPROVAL' AND NEW.status IN ('SEALED', 'VOID'))
  OR (OLD.status = 'SEALED' AND NEW.status = 'VOID')
)
BEGIN
  SELECT RAISE(ABORT, 'snapshot status transition is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS sealed_snapshot_requires_seal_evidence
BEFORE UPDATE OF status ON EntrySnapshot
WHEN NEW.status = 'SEALED' AND (NEW.sealedAt IS NULL OR NEW.sealedBy IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot requires immutable seal evidence');
END;

CREATE TRIGGER IF NOT EXISTS frozen_snapshot_no_delete
BEFORE DELETE ON EntrySnapshot
WHEN OLD.status IN ('AWAITING_APPROVAL', 'SEALED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'approved snapshot evidence must be retained');
END;

CREATE TRIGGER IF NOT EXISTS frozen_snapshot_row_no_insert
BEFORE INSERT ON EntrySnapshotRow
WHEN (SELECT status FROM EntrySnapshot WHERE id = NEW.snapshotId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'snapshot rows may be inserted only while the snapshot is a draft');
END;

CREATE TRIGGER IF NOT EXISTS sealed_snapshot_row_no_update
BEFORE UPDATE ON EntrySnapshotRow
WHEN (SELECT status FROM EntrySnapshot WHERE id = OLD.snapshotId) IN ('AWAITING_APPROVAL', 'SEALED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS snapshot_approval_no_insert_after_draft
BEFORE INSERT ON SnapshotApproval
WHEN (SELECT status FROM EntrySnapshot WHERE id = NEW.snapshotId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'snapshot approvals may be created only while the snapshot is a draft');
END;

CREATE TRIGGER IF NOT EXISTS snapshot_approval_transition_valid
BEFORE UPDATE ON SnapshotApproval
WHEN NOT (
  (SELECT status FROM EntrySnapshot WHERE id = OLD.snapshotId) = 'AWAITING_APPROVAL'
  AND OLD.status = 'PENDING'
  AND NEW.status = 'APPROVED'
  AND NEW.id = OLD.id
  AND NEW.snapshotId = OLD.snapshotId
  AND NEW.kind = OLD.kind
  AND NEW.approverId IS NOT NULL
  AND NEW.notes IS NOT NULL
  AND NEW.decidedAt IS NOT NULL
  AND NEW.createdAt = OLD.createdAt
)
BEGIN
  SELECT RAISE(ABORT, 'snapshot approvals are immutable except for the pending approval decision');
END;

CREATE TRIGGER IF NOT EXISTS snapshot_approval_no_delete
BEFORE DELETE ON SnapshotApproval
BEGIN
  SELECT RAISE(ABORT, 'snapshot approval evidence must be retained');
END;

CREATE TRIGGER IF NOT EXISTS draw_evidence_no_update
BEFORE UPDATE OF tenantId, campaignId, snapshotId, provider, algorithm, algorithmVersion,
  seedHash, encryptedSeed, resultChecksum, operatorId, witnessId, conductedAt, createdAt
ON Draw
BEGIN
  SELECT RAISE(ABORT, 'draw execution evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS draw_evidence_no_delete
BEFORE DELETE ON Draw
BEGIN
  SELECT RAISE(ABORT, 'draw execution evidence must be retained');
END;

CREATE TRIGGER IF NOT EXISTS draw_candidate_insert_draft_only
BEFORE INSERT ON DrawCandidate
WHEN (SELECT status FROM Draw WHERE id = NEW.drawId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'draw candidates may be inserted only during draft draw construction');
END;

CREATE TRIGGER IF NOT EXISTS draw_candidate_selection_no_update
BEFORE UPDATE OF drawId, entryAccountId, rank, selectedEntry, createdAt ON DrawCandidate
BEGIN
  SELECT RAISE(ABORT, 'draw candidate selection evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS draw_candidate_no_delete
BEFORE DELETE ON DrawCandidate
BEGIN
  SELECT RAISE(ABORT, 'draw candidate selection evidence must be retained');
END;

CREATE TRIGGER IF NOT EXISTS sealed_snapshot_row_no_delete
BEFORE DELETE ON EntrySnapshotRow
WHEN (SELECT status FROM EntrySnapshot WHERE id = OLD.snapshotId) IN ('AWAITING_APPROVAL', 'SEALED', 'VOID')
BEGIN
  SELECT RAISE(ABORT, 'sealed snapshot rows are immutable');
END;

CREATE TRIGGER IF NOT EXISTS entry_adjustment_approval_no_update
BEFORE UPDATE ON EntryAdjustmentApproval
BEGIN
  SELECT RAISE(ABORT, 'entry adjustment approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS entry_adjustment_approval_no_delete
BEFORE DELETE ON EntryAdjustmentApproval
BEGIN
  SELECT RAISE(ABORT, 'entry adjustment approvals are immutable');
END;

CREATE TRIGGER IF NOT EXISTS refund_allocation_amounts_insert
BEFORE INSERT ON Refund
WHEN NEW.amountCents <= 0
  OR NEW.merchandiseCents < 0
  OR NEW.shippingCents < 0
  OR NEW.taxCents < 0
  OR NEW.amountCents <> NEW.merchandiseCents + NEW.shippingCents + NEW.taxCents
BEGIN
  SELECT RAISE(ABORT, 'refund monetary allocation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS refund_authorization_fields_immutable
BEFORE UPDATE OF tenantId, orderId, paymentId, amountCents, merchandiseCents, shippingCents, taxCents, currency, reason, providerReason, evidence, allocationFingerprint, idempotencyKey, requestedBy ON Refund
BEGIN
  SELECT RAISE(ABORT, 'refund authorization fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS refund_provider_id_immutable
BEFORE UPDATE OF providerRefundId ON Refund
WHEN OLD.providerRefundId IS NOT NULL AND NEW.providerRefundId IS NOT OLD.providerRefundId
BEGIN
  SELECT RAISE(ABORT, 'refund provider id is immutable once bound');
END;

CREATE TRIGGER IF NOT EXISTS completed_refund_immutable
BEFORE UPDATE ON Refund
WHEN OLD.status = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'completed refunds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS completed_refund_no_delete
BEFORE DELETE ON Refund
WHEN OLD.status = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'completed refunds are immutable');
END;

CREATE TRIGGER IF NOT EXISTS failed_refund_immutable
BEFORE UPDATE ON Refund
WHEN OLD.status = 'FAILED'
BEGIN
  SELECT RAISE(ABORT, 'failed refund evidence is immutable; authorize a new retry intent');
END;

CREATE TRIGGER IF NOT EXISTS failed_refund_no_delete
BEFORE DELETE ON Refund
WHEN OLD.status = 'FAILED'
BEGIN
  SELECT RAISE(ABORT, 'failed refund evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS refund_completion_allocation_matches
BEFORE UPDATE OF status ON Refund
WHEN NEW.status = 'COMPLETED'
  AND (
    length(NEW.allocationFingerprint) <> 64
    OR COALESCE((SELECT SUM(amountCents) FROM RefundLineAllocation WHERE refundId = NEW.id), 0) <> NEW.merchandiseCents
  )
BEGIN
  SELECT RAISE(ABORT, 'refund merchandise allocation does not match authorization');
END;

CREATE TRIGGER IF NOT EXISTS refund_line_allocation_valid_insert
BEFORE INSERT ON RefundLineAllocation
WHEN NEW.amountCents <= 0 OR NEW.entriesReversed < 0
BEGIN
  SELECT RAISE(ABORT, 'refund line allocation is invalid');
END;

CREATE TRIGGER IF NOT EXISTS refund_line_allocation_no_update
BEFORE UPDATE ON RefundLineAllocation
BEGIN
  SELECT RAISE(ABORT, 'refund line allocations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS refund_line_allocation_no_delete
BEFORE DELETE ON RefundLineAllocation
BEGIN
  SELECT RAISE(ABORT, 'refund line allocations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS completed_refund_no_new_allocation
BEFORE INSERT ON RefundLineAllocation
WHEN (SELECT status FROM Refund WHERE id = NEW.refundId) = 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'completed refund allocations are frozen');
END;

CREATE TRIGGER IF NOT EXISTS entry_adjustment_exactly_one_source_insert
BEFORE INSERT ON EntryAdjustmentRequest
WHEN (NEW.refundId IS NULL) = (NEW.subscriptionCycleId IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'entry adjustment requires exactly one immutable source');
END;

CREATE TRIGGER IF NOT EXISTS entry_adjustment_source_no_update
BEFORE UPDATE OF refundId, subscriptionCycleId ON EntryAdjustmentRequest
BEGIN
  SELECT RAISE(ABORT, 'entry adjustment source is immutable');
END;
CREATE TRIGGER IF NOT EXISTS account_challenge_one_active_insert
BEFORE INSERT ON AccountChallenge
WHEN EXISTS (
  SELECT 1 FROM AccountChallenge
  WHERE tenantId = NEW.tenantId
    AND userId = NEW.userId
    AND purpose = NEW.purpose
    AND consumedAt IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'only one unconsumed account challenge per user and purpose is permitted');
END;

-- The approved campaign checksum binds the active ordinary purchase catalog.
-- Inventory quantities and presentation-only copy may still change, but no
-- target, price, multiplier, active-option, or collection identity may drift
-- while an approved campaign is scheduled or live.
CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_no_insert
BEFORE INSERT ON Product
WHEN NEW.status = 'ACTIVE'
  AND NEW.productType <> 'MEMBERSHIP'
  AND EXISTS (
    SELECT 1 FROM Campaign
    WHERE tenantId = NEW.tenantId
      AND approvedAt IS NOT NULL
      AND status IN ('SCHEDULED', 'LIVE')
  )
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign catalog is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_no_update
BEFORE UPDATE OF tenantId, slug, status, productType, category, priceCents, entryMultiplier ON Product
WHEN (
    (OLD.status = 'ACTIVE' AND OLD.productType <> 'MEMBERSHIP')
    OR (NEW.status = 'ACTIVE' AND NEW.productType <> 'MEMBERSHIP')
  )
  AND EXISTS (
    SELECT 1 FROM Campaign
    WHERE tenantId IN (OLD.tenantId, NEW.tenantId)
      AND approvedAt IS NOT NULL
      AND status IN ('SCHEDULED', 'LIVE')
  )
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign catalog is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_no_delete
BEFORE DELETE ON Product
WHEN OLD.status = 'ACTIVE'
  AND OLD.productType <> 'MEMBERSHIP'
  AND EXISTS (
    SELECT 1 FROM Campaign
    WHERE tenantId = OLD.tenantId
      AND approvedAt IS NOT NULL
      AND status IN ('SCHEDULED', 'LIVE')
  )
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign catalog is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_variant_no_insert
BEFORE INSERT ON ProductVariant
WHEN NEW.status = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM Product product
    JOIN Campaign campaign ON campaign.tenantId = product.tenantId
    WHERE product.id = NEW.productId
      AND product.status = 'ACTIVE'
      AND product.productType <> 'MEMBERSHIP'
      AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
  )
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign product options are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_variant_no_update
BEFORE UPDATE OF tenantId, productId, sku, priceCents, status ON ProductVariant
WHEN EXISTS (
  SELECT 1
  FROM Product product
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE product.id IN (OLD.productId, NEW.productId)
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign product options are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_variant_no_delete
BEFORE DELETE ON ProductVariant
WHEN EXISTS (
  SELECT 1
  FROM Product product
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE product.id = OLD.productId
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign product options are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_collection_no_insert
BEFORE INSERT ON ProductCollection
WHEN EXISTS (
  SELECT 1
  FROM Product product
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE product.id = NEW.productId
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign collection targeting is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_collection_no_update
BEFORE UPDATE OF productId, collectionId ON ProductCollection
WHEN EXISTS (
  SELECT 1
  FROM Product product
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE product.id IN (OLD.productId, NEW.productId)
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign collection targeting is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_product_collection_no_delete
BEFORE DELETE ON ProductCollection
WHEN EXISTS (
  SELECT 1
  FROM Product product
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE product.id = OLD.productId
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign collection targeting is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_collection_no_update
BEFORE UPDATE OF slug ON Collection
WHEN EXISTS (
  SELECT 1
  FROM ProductCollection membership
  JOIN Product product ON product.id = membership.productId
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE membership.collectionId = OLD.id
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign collection targeting is immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_catalog_collection_no_delete
BEFORE DELETE ON Collection
WHEN EXISTS (
  SELECT 1
  FROM ProductCollection membership
  JOIN Product product ON product.id = membership.productId
  JOIN Campaign campaign ON campaign.tenantId = product.tenantId
  WHERE membership.collectionId = OLD.id
    AND product.status = 'ACTIVE'
    AND product.productType <> 'MEMBERSHIP'
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved scheduled/live campaign collection targeting is immutable');
END;

-- Membership entry bands bind the exact plan and product transaction facts
-- offered during a campaign. Scheduled/live facts are frozen; the persisted
-- release manifest remains authoritative after entry closes.
CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_plan_no_update
BEFORE UPDATE OF tenantId, productId, name, status, interval, intervalCount,
  priceCents, currency, baseEntries, providerPriceId
ON SubscriptionPlan
WHEN EXISTS (
  SELECT 1
  FROM MembershipEntryBand band
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE band.planId = OLD.id
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership plan facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_plan_no_delete
BEFORE DELETE ON SubscriptionPlan
WHEN EXISTS (
  SELECT 1
  FROM MembershipEntryBand band
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE band.planId = OLD.id
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership plan facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_product_no_update
BEFORE UPDATE OF tenantId, slug, title, status, productType, category,
  priceCents, entryMultiplier
ON Product
WHEN EXISTS (
  SELECT 1
  FROM SubscriptionPlan plan
  JOIN MembershipEntryBand band ON band.planId = plan.id
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE plan.productId = OLD.id
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership product facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_product_no_delete
BEFORE DELETE ON Product
WHEN EXISTS (
  SELECT 1
  FROM SubscriptionPlan plan
  JOIN MembershipEntryBand band ON band.planId = plan.id
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE plan.productId = OLD.id
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership product facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_variant_no_insert
BEFORE INSERT ON ProductVariant
WHEN EXISTS (
  SELECT 1
  FROM SubscriptionPlan plan
  JOIN MembershipEntryBand band ON band.planId = plan.id
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE plan.productId = NEW.productId
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership product options are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_variant_no_update
BEFORE UPDATE OF tenantId, productId, sku, title, priceCents, status, createdAt
ON ProductVariant
WHEN EXISTS (
  SELECT 1
  FROM SubscriptionPlan plan
  JOIN MembershipEntryBand band ON band.planId = plan.id
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE plan.productId IN (OLD.productId, NEW.productId)
    AND campaign.approvedAt IS NOT NULL
      AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership product options are immutable');
END;

CREATE TRIGGER IF NOT EXISTS protected_campaign_membership_variant_no_delete
BEFORE DELETE ON ProductVariant
WHEN EXISTS (
  SELECT 1
  FROM SubscriptionPlan plan
  JOIN MembershipEntryBand band ON band.planId = plan.id
  JOIN Campaign campaign ON campaign.id = band.campaignId
  WHERE plan.productId = OLD.productId
    AND campaign.approvedAt IS NOT NULL
    AND campaign.status IN ('SCHEDULED', 'LIVE')
)
BEGIN
  SELECT RAISE(ABORT, 'approved campaign membership product options are immutable');
END;
