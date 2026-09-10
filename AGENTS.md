# AGENTS.md

Instructions for AI coding assistants working **in** this repository.

If you are integrating sendrail into *another* project, you want
[`docs/ai-prompts.md`](docs/ai-prompts.md) instead.

## What this package is

Email deliverability on your own AWS SES account: sending, delivery feedback,
suppression and reputation. Ports and adapters throughout — the package assumes
no ORM, no schema, not even a database.

It is **not** a SendGrid clone. No HTTP API beyond two optional Express routers,
no dashboard, no multi-tenancy, no template engine, no queue. Do not add any of
them. See README **What this is not**.

## Invariants — do not break these

These are enforced by tests and CI. If a change makes one fail, the change is
wrong, not the test.

1. **Core imports no AWS, NestJS or Express.** `src/architecture.spec.ts` walks
   the real import graph from each entry point. Adding a re-export to a barrel
   is the usual way this breaks. Provider-specific code lives under its own
   entry point.

2. **`sendrail/nest` must not eagerly load the AWS SDK.** `EmailModule` reaches
   SES through `await import('sendrail/ses')` — a self-reference, resolved via
   the package's own exports map, with `sendrail` marked external in the tsup
   build. Bundling it lets esbuild hoist the AWS `require` and silently defeats
   the point. `scripts/check-install.mjs` proves it against a real install.

3. **`types` goes inside each export condition**, never at the top level.
   `attw --pack .` in CI catches regressions.

4. **The node10 shim directories (`ses/`, `nest/`, `express/`, `testing/`) are
   load-bearing.** Legacy `moduleResolution` ignores `exports` entirely and is
   still the default in a stock NestJS tsconfig. `examples/nestjs` deliberately
   uses that config, so removing a shim breaks its build. See
   `SUBPATH-SHIMS.md`.

5. **`transport/mime.ts` must import `nodemailer/lib/mail-composer/index.js`
   with the explicit filename.** The directory form works in CJS and throws
   `ERR_UNSUPPORTED_DIR_IMPORT` in ESM, breaking the ESM build for every
   consumer. A green build does not catch it.

6. **No business coupling.** This was extracted from a private monorepo. CI
   greps for its vocabulary in `src/`, the README and the docs.

## The docblocks are the deliverable

Several non-obvious choices are explained in comments, and those explanations
are load-bearing — they are why this package was worth extracting rather than
rewriting. When editing, preserve the reasoning:

- why validation runs before suppression (local computation before a store read)
- why the DNS check fails open (a resolver hiccup must not drop legitimate mail)
- why a transport failure logs WARN, not ERROR (usually transient; paging on a
  self-healing condition buries the signal)
- why reputation increments must be atomic upserts (sends and webhooks race)
- why refusals are recorded rather than dropped (a gap in the log is not an
  answer)
- why the provider message id is correlated before the recipient fallback
- why only hard bounces suppress

## Tests

231 of the tests came from the original package and are treated as a fixed
baseline. **Never edit an assertion to make a test pass** — that is a signal the
behaviour broke. Stop and report it instead.

```bash
pnpm test           # 286 tests, with coverage gates (90/85)
pnpm typecheck      # includes spec files
pnpm build
pnpm attw           # types resolution across node10/node16/bundler
pnpm check:install  # optional-peer split, against a packed tarball
```

`pnpm check:install` is the one that catches what nothing else does. Two things
about it that quietly void the check if you change them: the scratch project
must live **outside** this repo (Node resolution walks up and finds our own
`node_modules`), and assertions about an entry that should fail must match the
**specific** missing module.

## Conventions

- British spelling in prose; American in code identifiers where an API demands it.
- Comments explain *why*, not *what*. If a line needs a comment to say what it
  does, rename something instead.
- No dependency is added without a reason that survives the question "what
  breaks if the host does this themselves?"
