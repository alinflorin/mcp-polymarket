---
"@iqai/mcp-polymarket": patch
---

Fix npm compatibility by replacing JSR protocol dependency

- Replace `jsr:@hk/polymarket` with npm-compatible `@jsr/hk__polymarket` package
- Fix `EUNSUPPORTEDPROTOCOL` error when installing with npm/npx
- Enable installation with all package managers (npm, pnpm, yarn) without JSR-specific syntax
