import type {
  ProjectPolicy,
  ProviderConfig,
} from "@graph-engineering/contracts";

// The one estimate of how many model tokens a serialized request uses, for
// every comparison of request size with a token budget (maxContextTokens,
// retrieval budgets, routed budgets). It names no tokenizer. Common BPE
// tokenizers average about 4 bytes of English prose per token, but dense
// code, digits, JSON escapes and hex or base64 run nearer 1.5 to 2.5 bytes
// per token, so dividing UTF-8 bytes by 2 (rounded up) is the conservative
// estimate for workers and the planner.
export const BYTES_PER_TOKEN = 2;

export const tokensForBytes = (bytes: number): number =>
  Math.ceil(bytes / BYTES_PER_TOKEN);

export const estimateTokens = (text: string): number =>
  tokensForBytes(Buffer.byteLength(text, "utf8"));

// The strict estimate for gates that judge a change (the code-review gate and
// the security audit): one token per UTF-8 byte, an upper bound for every
// tokenizer, so a gate refuses rather than judges input a provider might cut.
export const strictTokensForBytes = (bytes: number): number => bytes;

// The input budget for one request to a provider: the smaller of the policy
// and provider context limits, less the output reservation, so input plus
// output fits the window and a server that cuts an over-long prompt never
// drops mandatory text. The reservation is policy.maxOutputTokens (providers
// declare no output cap of their own), but never more than half the window:
// a policy whose output cap equals its context limit (the defaults are 16,000
// each) keeps half the window for input instead of none.
export function outputReservation(
  policy: Pick<ProjectPolicy, "maxContextTokens" | "maxOutputTokens">,
  provider?: Pick<ProviderConfig, "maxContextTokens">,
): number {
  const window = Math.min(
    policy.maxContextTokens,
    provider?.maxContextTokens ?? policy.maxContextTokens,
  );
  return Math.min(policy.maxOutputTokens, Math.floor(window / 2));
}

export function inputTokenCeiling(
  policy: Pick<ProjectPolicy, "maxContextTokens" | "maxOutputTokens">,
  provider?: Pick<ProviderConfig, "maxContextTokens">,
): number {
  const window = Math.min(
    policy.maxContextTokens,
    provider?.maxContextTokens ?? policy.maxContextTokens,
  );
  return window - outputReservation(policy, provider);
}

// Gates answer with a compact, schema-bound verdict, not a patch, so they
// reserve (and request) far less output than a worker: the review gate at most
// REVIEW_OUTPUT_TOKENS, the security audit at most AUDIT_OUTPUT_TOKENS. The
// rest of the window stays available for the change being judged. An answer
// that hits the cap is reported as truncated, never accepted.
export const REVIEW_OUTPUT_TOKENS = 4096;
export const AUDIT_OUTPUT_TOKENS = 8192;
export function withOutputCap<T extends Pick<ProjectPolicy, "maxOutputTokens">>(
  policy: T,
  cap: number,
): T {
  return { ...policy, maxOutputTokens: Math.min(policy.maxOutputTokens, cap) };
}
