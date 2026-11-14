import { PartnerPendingConnector } from "../croma/partner-pending-connector.js";

/** Reliance Digital: no public product API/feed found (2026-11); partner agreement required. */
export const relianceDigitalConnector = () =>
  new PartnerPendingConnector(
    "reliance_digital",
    "Reliance Digital",
    "No public product API or feed found; requires a partner/feed agreement with Reliance Digital.",
  );
