# Default models (global and per project)

Status: implemented on the user's request (2026-10-16): a Models page in the settings with a default model, and a default model per project that overrides it.

## 1. What it is

The model a **new session** starts with: provider, model and optional reasoning effort. It prefills the "New session" form and the agent picker of "New task → Start an agent now". The user can still change it in those forms; nothing is forced on an existing session.

The default also carries an optional **permission mode** (2026-10-23). With no mode set, the form keeps the latest session's mode when the provider is the same, else the provider default. Not covered: the summary model (separate, see §4).

## 2. Precedence

`effectiveAgentModel(project, global)` in `shared/agent-defaults.ts`, strongest first:

1. the project's `agentModel`, when set;
2. the global default (`models` host setting), when set (`defaultProvider` and `defaultModel` both non-empty);
3. nothing: the form starts from the latest session's settings, as before this feature (`startingAgent`).

A project default replaces the global one as a whole (provider, model and reasoning together); it is never merged field by field. If the chosen provider is not available on this machine the form falls back as it always did (an available provider, its default model).

## 3. Data

- Global: host-scoped setting `models` = `{ defaultProvider, defaultModel, defaultThinking, defaultMode }`, empty strings meaning none. Registered in `index.server.ts`.
- Project: optional `agentModel: { provider, model, thinking?, mode? }` on the project record. No board migration (absent on existing projects). `projects.update` takes `agentModel`; a model sets it, `null` removes it; it goes through the usual project revision check, so a stale edit is rejected. The model is validated by `agentModelSchema` (strict, non-empty ids).

## 4. UI

- **Settings → Models**: *Default model* (Provider, Model, Reasoning) and *Summary models* (an ordered fallback list; see [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md)). Provider's first choice is **Automatic** (no default). Choosing a provider also chooses its default model, so a default is always complete.
- **Project settings → Default model**: the same three rows; the provider's first choice reads **Global default (…)** (the current global one, or Automatic) and means "no override".
- A **Permissions** row (the provider's modes; "Same as latest session" keeps none: the form then keeps the latest session's mode when it uses the same provider, else the provider default) follows Reasoning; changing the provider clears it, since mode ids belong to a provider.
- The Reasoning row only appears when the model offers options; "Model default" stores no reasoning, so the session form suggests Extra High when the model offers it (see "Reasoning default"), else the model's own.
- A default model has no speed. The session form keeps the latest session's speed when the default uses the same provider ([AGENT-SPEED-SPEC](AGENT-SPEED-SPEC.md)).

## 5. Acceptance

[verification/model-defaults.md](verification/model-defaults.md)

## Automatic approval default (2026-10-29)

New card/session pickers suggest Claude `auto` and Codex `auto-review` when no explicit or remembered permission mode is set. Applies on initial selection, reset and provider switch. Explicit model defaults and remembered selections win. Unsupported modes fall back to the provider default. Existing sessions are unchanged.

Custom providers that extend Claude or Codex (`claude-connected`, `codex-connected`, …) get the same suggestions (2026-10-30). Paseo does not tell clients what a custom provider extends, so `providerBase` in `shared/agent-defaults.ts` recognises it by its permission modes: `auto-review` means Codex, `acceptEdits` plus `bypassPermissions` means Claude; any other provider gets no suggestion. The suggestion is worked out in the picker (`client/agent-choice.tsx`) for a mode not chosen yet, once the provider's modes are listed; the form cannot be submitted before that. `startingAgent` passes only remembered values on.

## Reasoning default (2026-10-30)

New card/session pickers suggest reasoning `xhigh` (Extra High) for any provider whose chosen model offers it, when no reasoning is chosen or remembered (`suggestedThinking` in `shared/agent-defaults.ts`). Applies on initial selection, reset, provider switch and model switch. A model without `xhigh` (for example GLM 5.3) keeps its own default. An explicit pick in the form, including **Model default**, a default model's stored reasoning and the latest session's reasoning win; a latest session that ran at the model default counts as no reasoning remembered, like the permission mode.
