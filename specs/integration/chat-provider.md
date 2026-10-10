# OpenAI-compatible chat provider

- ID: chat-provider
- Status: implemented
- Area: integration

## Problem

Operators want to use hosted models that speak the OpenAI chat-completions
protocol (a hosted Qwen, a model gateway, a vLLM server) as cloud workers,
planners and reviewers. The only OpenAI-compatible path was the `local` kind,
which is loopback-only and treated as local for export, so a hosted model had
no correct kind. Provider-kind lists were also repeated across the engine, so
adding a kind risked missing a privacy check.

## Acceptance criteria

- AC1: A `chat` provider calls `POST {endpoint}/chat/completions` with a strict `json_schema` response format, the model, system and user messages and the output limit, sends the key from `apiKeyEnv` as a bearer token, and sends no local-server options such as thinking toggles.
  - Test: packages/engine/tests/chat-provider.test.ts :: calls chat completions with a strict JSON schema and bearer key, with no local-server options
- AC2: A `chat` provider needs an endpoint and an `apiKeyEnv`; its endpoint must be HTTPS on a host in `policy.allowedHosts`, with no loopback exception and no credentials in the URL; an offline policy refuses it; local inference options are refused for it; `provider-add <id> chat <model> --endpoint <url> --api-key-env <VAR>` stores it and, like any cloud worker, does not permit it without `--enable`.
  - Test: packages/engine/tests/chat-provider.test.ts :: requires an HTTPS endpoint on an allowlisted host, an API key variable and an online policy
  - Test: packages/engine/tests/cli.test.ts :: adds a chat provider only with its endpoint and API key variable, and never permits it without --enable
- AC3: A `chat` provider is classified as cloud exactly like `openai`: its worker request carries only exportable, secret-free context items; secrets in the task, plan input or review input are refused before any request; it can plan and review as an API provider; and a cloud-backed client's plan that mixes it with a local worker, tester or reviewer is refused before it is stored.
  - Test: packages/engine/tests/chat-provider.test.ts :: never sends a chat provider a non-exportable or secret-bearing file
  - Test: packages/engine/tests/chat-provider.test.ts :: can plan and review as an API provider, with the cloud secret refusal
  - Test: packages/engine/tests/chat-provider.test.ts :: refuses a cloud client's plan that mixes a chat provider with local roles
- AC4: A `chat` provider is priced like other API providers: recorded prices admit it under a numeric cost cap and price its usage, and without prices a numeric cap refuses it with the same refusal as an unpriced `openai` worker and its calls have no cost estimate.
  - Test: packages/engine/tests/chat-provider.test.ts :: is priced and capped like other API providers
- AC5: Provider kinds are defined once in `@graph-engineering/contracts` as `LOCAL_KINDS`, `API_KINDS` (`openai`, `anthropic`, `chat`) and `INSTALLED_KINDS`, with `isInstalledKind`, `isApiKind` and `isCloudKind` (every kind but `local`, so an unknown kind fails closed); the engine's installed-agent and API allowlists use them, and `chat` keeps the ordinary worker deadline and is never an installed worker.
  - Test: packages/engine/tests/chat-provider.test.ts :: defines each kind once and classifies chat as a cloud API kind

## Security considerations

`chat` sends repository context to a remote service, so every check that
separates local from cloud consumers treats it as cloud. Those checks compare
against `local` (`kind !== "local"`), so a new non-local kind lands on the
cloud side by default; only positive allowlists (planner, reviewer, priced
kinds) name it. The endpoint is untrusted configuration: it must be HTTPS to
an exact allowlisted host, credentials in the URL are refused, redirects are
refused by the transport, and the API key is read from a named environment
variable that may not be a decision credential. Model output is parsed
against the same strict schemas as other providers.

## Non-goals

- Thinking or reasoning toggles specific to a model server; `localOptions` stays local-only.
- A default endpoint or key variable for `chat`.
- Treating a hosted endpoint on loopback as local.
- Changing the sealed evaluation schemas, which record their own provider kinds.
