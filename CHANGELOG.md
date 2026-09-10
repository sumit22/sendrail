# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial extraction from a private monorepo: outbound send path (validate →
  suppression-check → send → record), SES/SNS delivery feedback loop, per-address
  reputation rollups, delivery log with retention pruning, SES account health,
  and SES/SMTP/logging transports.
- Subpath entry points: `sendrail`, `sendrail/ses`, `sendrail/nest`,
  `sendrail/express`, `sendrail/testing`.
- Mountable Express routers for the feedback webhook and the admin read/write API.
- `sendrail/testing` — the three store ports as an executable contract suite, so
  a host can verify its own adapter.
- `docs/schema.sql` — reference PostgreSQL schema for the three tables, with the
  atomic-upsert and still-in-SENT rules written as SQL.
- `docs/aws-setup.md` — AWS CLI and profiles, the IAM policy the application
  needs, production access per region, DNS records, From/Reply-To, environment
  variables, bring-up order, warm-up ramp, troubleshooting, and a copy-paste
  production-access request.
- Two runnable example apps (Express and NestJS) on the logging transport and
  in-memory stores.
