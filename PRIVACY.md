# Data Privacy — Third-Party AI Processing

This document records exactly what user data leaves Yomeet's servers for AI
processing, what does **not**, and the account-level setting (Zero Data
Retention) that governs how long the provider keeps it. Keep it up to date when
AI call sites change.

## Provider

- **OpenAI API only.** Gemini / Google AI is **not** used.
- We call the OpenAI **API** (not ChatGPT). Per OpenAI policy, **API data is not
  used to train their models**. By default it is retained up to ~30 days for
  abuse monitoring, then deleted — or **0 days** if Zero Data Retention (ZDR) is
  enabled on the org (see below).

## What is sent to OpenAI, per feature

| Feature | What is sent | What is NOT sent |
|---|---|---|
| **Chat translation** (`chat/translation.service.ts`) | The message text + the target language codes (e.g. `en, fr`). | Sender/recipient names, user IDs, phone numbers, conversation IDs, or any account metadata. |
| **Voice transcription** (`chat/transcription.service.ts`) | The audio file only. | `userId` is used locally for rate limits / storage — it is never sent to OpenAI. |
| **Content moderation** (`shared/moderation.service.ts`) | The text or image being checked. | No identity or account metadata. |
| **Kora AI assistant** (`ai/llm.service.ts`) | The conversation messages' `content` + the system prompt. | Raw account identity is not attached to the model input; `userId` is only used app-side to run tools. |

**Principle: data minimization.** Every call sends only the content the feature
needs to function. No user identity or PII is attached beyond the content
itself. When adding a new AI call site, keep it content-only.

## What we log

- We do **not** log message content, transcripts, or AI request/response bodies.
- Only error reasons / status are logged (e.g. "Moderation classify failed").

## Encryption at rest

- Message content is encrypted at rest in the database (AES-256-GCM) — see
  `shared/message-crypto.ts`. This protects DB dumps / stolen backups. It is
  **not** end-to-end: the server decrypts in memory to run the features above,
  which is why translation and spam detection keep working.

## The real guardrail: Zero Data Retention (ZDR)

No application code can change how long OpenAI stores data — that is an
account-level setting.

- **Default:** OpenAI does not train on API data; retains ~30 days for abuse
  monitoring.
- **With ZDR:** OpenAI stores **nothing** — request and response are discarded
  right after processing.

**To enable:** request ZDR for the org from OpenAI (dashboard → contact
sales/support, or the enterprise privacy/ZDR request form). Once approved it
applies to the existing API key automatically — **no code change needed**. Some
logging/tool features may be limited under ZDR, but translation, transcription,
moderation and chat completions are fully supported.

## What we deliberately do NOT do

- We do **not** put "do not retain this" instructions in the prompts — that has
  no effect on OpenAI's server-side retention and would be security theater.
- We do **not** redact PII before translation — it would blank out phone
  numbers / emails inside the translated message itself and break the feature.
  Retention is handled by ZDR instead.
