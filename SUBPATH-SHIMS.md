# Why `ses/`, `nest/`, `express/` and `testing/` exist

Each holds nothing but a `package.json` pointing into `dist/`.

Modern resolvers (`node16`, `bundler`) read the `exports` map and never look at
these directories. The legacy `node10` algorithm — still what TypeScript uses
whenever `moduleResolution` is unset under `"module": "commonjs"`, which is the
default in a stock NestJS project — ignores `exports` entirely and resolves
`sendrail/nest` as a path under the package root.

Without these shims that resolution fails, and a NestJS user importing
`sendrail/nest` gets "Cannot find module" despite a correct exports map.
`attw --pack .` reports it as `node10: 💀 Resolution failed`, and CI treats that
as a failure.
