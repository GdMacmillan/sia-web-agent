// Copied from the host's generated service definition. Do not edit by hand.
//
// The host regenerates these values from its service definition; they are
// vendored here only so the agent can name the two read-only knowledge
// verbs it calls. The host's responder rejects a call whose verb hash is
// stale, so a hand-edited value fails closed — every read below simply
// returns nothing until the file is re-vendored from the host's codegen.

/** Service the knowledge verbs belong to. */
export const DB_SERVICE = "db";
export const DB_SERVICE_VERSION = "v1";

/** Whole-service schema hash at the time these verbs were vendored. */
export const DB_SCHEMA_HASH =
  "27dad58eec160af3095da37bddb4a9102b44e2927b7eaf0f44ae9b931ebdf83b";

/** The platform's refusal record: a pure read with no input. */
export const REFUSAL_RECORD_VERB = "knowledge.refusal-record";
export const REFUSAL_RECORD_VERB_HASH =
  "75a43022b5bde7979a1f49d6ca7b5fc06c8d3362183f4ab80d001479fd9e2f02";

/**
 * The failure-modes catalogue the keeper wrote about this agent. The host
 * fills in which agent from the caller's own token; the agent never names
 * one.
 */
export const FAILURE_MODES_VERB = "knowledge.failure-modes.get";
export const FAILURE_MODES_VERB_HASH =
  "ae45c226d10fb9b53f1736089ea94d34085c0923f6fceafae5dcc3c741c32870";
