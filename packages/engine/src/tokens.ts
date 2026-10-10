// The one estimate of how many model tokens a serialized request uses, for
// every comparison of request size with a token budget (maxContextTokens,
// retrieval budgets, routed budgets). It names no tokenizer: common BPE
// tokenizers average about 4 bytes of English or code per token, and fewer
// for dense punctuation or non-Latin text, so dividing UTF-8 bytes by 3
// (rounded up) over-counts typical input by about a third. That leaves a
// margin for tokenizer differences while letting a 16k-token model receive a
// realistic window, where counting one token per byte offered a third of it.
export const BYTES_PER_TOKEN = 3;

export const tokensForBytes = (bytes: number): number =>
  Math.ceil(bytes / BYTES_PER_TOKEN);

export const estimateTokens = (text: string): number =>
  tokensForBytes(Buffer.byteLength(text, "utf8"));
