# Pass-Through Prompt Implementation Plan

**Goal:** Remove prompt injection while retaining required CommandCode adaptation.

**Architecture:** Keep the pure translators and current route error mapping.
The known upstream schema has no native structured-output field, so reject
non-text formats rather than silently ignoring them or generating instructions.

**Tech Stack:** TypeScript, Fastify, Zod, Vitest.

1. Add failing translator tests for rejecting JSON formats, preserving empty
   system message boundaries, and Responses text format handling. Add route
   tests proving unsupported formats return 400 before calling upstream.
2. Remove `structuredOutputInstruction`; reject non-text `response_format` in
   `src/translate/generate-request.ts` and assign `system` directly.
3. Preserve empty system/developer entries in `src/translate/messages.ts`.
   Preserve explicitly empty Responses instructions and map text format without
   converting it into a JSON schema in `src/translate/responses.ts`.
4. Document unsupported structured output, stable separators, protocol limits,
   and the absence of a verified cache-rate improvement in README.md.
5. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
   Review the focused changes without reverting other work or committing.
