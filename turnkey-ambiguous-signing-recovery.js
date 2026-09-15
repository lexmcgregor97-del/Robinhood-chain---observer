import {
  turnkeyActivityTimestampMs, verifyAmbiguousSigningActivity,
} from "./turnkey-ambiguous-signing-evidence.js";

const PAGE_LIMIT = 100;
const SIGN_TRANSACTION = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2";
const COMPLETED = "ACTIVITY_STATUS_COMPLETED";
const activityFrom = (response) => response?.activity || response;

export async function findUniqueAmbiguousSigningActivity({
  record, getActivities, evidenceConfig, pageLimit = PAGE_LIMIT, maxPages = 100,
} = {}) {
  if (typeof getActivities !== "function") throw new Error("turnkey-list-activities-required");
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > PAGE_LIMIT
      || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error("turnkey-activity-pagination-config-invalid");
  }
  const matches = [];
  const seen = new Set();
  let before;
  let exhausted = false;
  let previousTime = Number.POSITIVE_INFINITY;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await getActivities({
      organizationId: evidenceConfig?.organizationId,
      filterByType: [SIGN_TRANSACTION], filterByStatus: [COMPLETED],
      paginationOptions: { limit: String(pageLimit), ...(before ? { before } : {}) },
    });
    const activities = response?.activities;
    if (!Array.isArray(activities) || activities.length > pageLimit) {
      throw new Error("turnkey-activity-page-invalid");
    }
    let crossedLowerBound = false;
    for (const activity of activities) {
      const id = String(activity?.id || "");
      if (!id || seen.has(id)) throw new Error("turnkey-activity-page-invalid");
      seen.add(id);
      let createdAt;
      try { createdAt = turnkeyActivityTimestampMs(activity.createdAt); } catch {
        throw new Error("turnkey-activity-page-invalid");
      }
      if (createdAt > previousTime) throw new Error("turnkey-activity-order-invalid");
      previousTime = createdAt;
      if (createdAt < Number(record?.signingRequestedAt)) crossedLowerBound = true;
      const verification = await verifyAmbiguousSigningActivity({ record, activity,
        ...evidenceConfig });
      if (verification.verified) matches.push(activity);
    }
    if (activities.length < pageLimit || crossedLowerBound) {
      exhausted = true;
      break;
    }
    before = String(activities.at(-1)?.id || "");
    if (!before) throw new Error("turnkey-activity-page-invalid");
  }
  if (!exhausted) throw new Error("turnkey-activity-pagination-limit-reached");
  if (matches.length !== 1) {
    throw new Error(matches.length ? "turnkey-activity-candidate-ambiguous"
      : "turnkey-activity-candidate-not-found");
  }
  return Object.freeze({ activityId: matches[0].id, scannedActivityCount: seen.size });
}

export async function restoreUniqueAmbiguousSigningActivity({
  record, resolver, getActivities, getActivity, evidenceConfig,
  operatorAssertion, now = Date.now(), pageLimit, maxPages,
} = {}) {
  if (!resolver || typeof getActivity !== "function") {
    throw new Error("turnkey-activity-restoration-config-invalid");
  }
  const selected = await findUniqueAmbiguousSigningActivity({ record, getActivities,
    evidenceConfig, pageLimit, maxPages });
  const refreshed = activityFrom(await getActivity({
    organizationId: evidenceConfig?.organizationId, activityId: selected.activityId,
  }));
  if (String(refreshed?.id || "") !== selected.activityId) {
    throw new Error("turnkey-activity-refetch-mismatch");
  }
  const resolution = await resolver.restoreSignedFromTurnkey(record.intentId, {
    activity: refreshed, ...evidenceConfig,
  }, { now, operatorAssertion });
  return Object.freeze({ ...resolution, activityId: selected.activityId,
    scannedActivityCount: selected.scannedActivityCount });
}
