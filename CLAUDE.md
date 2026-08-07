# Product priorities

These constraints govern any change to this codebase, human or AI-authored.

- Recommendation quality > link quantity.
- Never alter article prose to create links.
- Keep insertion deterministic.
- Never remove `verifyNoDrift` protections.
- Prefer sitemap/native fetching over paid crawling dependencies unless there is a substantial quality benefit.
- Avoid unnecessary LLM calls.
- Use human approval as the default workflow.
- Do not commit directly to `main`.
- New ranking behavior should be testable.
