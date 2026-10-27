## Changes track

- [ ] | Fix: project with same name should not be created |     |
- [x] | Request ID: header vs body mismatch (verify first). | Already verified, RequestId matches   |
- [ ] | Add `exposedHeaders: ['X-Request-Id']` to the backend’s CORS config, so the browser can read it.    |   |
- [ ] | `trust proxy` plus forwarding the client IP from the Next server (DESIGN §3). |     |
- [ ] | Typed enums in the OpenAPI spec for error codes, notification payloads and SSE events.  |   |