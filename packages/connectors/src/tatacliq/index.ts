import { PartnerPendingConnector } from "../croma/partner-pending-connector.js";

/** Tata CLiQ: affiliate networks offer tracking links only (2026-11); feed access needs a partner agreement. */
export const tataCliqConnector = () =>
  new PartnerPendingConnector(
    "tata_cliq",
    "Tata CLiQ",
    "No public product API or feed found (affiliate networks provide links only); requires a partner/feed agreement with Tata CLiQ.",
  );
