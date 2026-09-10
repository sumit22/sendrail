#!/usr/bin/env node
// Pack the package and load its entry points from real scratch installs, to
// prove the optional-peer split is genuine.
//
// This is the only check that catches an eagerly-hoisted require: a green build
// does not, `attw` does not, and `npm publish --dry-run` does not. Only a real
// install does.
//
// The claim being tested is NOT "every entry loads with nothing installed" —
// `sendrail/express` legitimately needs express, and `sendrail/nest` needs
// @nestjs/common. It is the sharper one:
//
//   * core loads with NO optional peer at all;
//   * each subpath needs ITS OWN peer and no other — in particular
//     `sendrail/nest` must load with NestJS present and the AWS SDK absent,
//     which is what the Nest module's lazy `import('sendrail/ses')` exists for.
//
// Three details that this script got wrong once, each of which quietly voids
// the whole check:
//
//   1. A scratch project MUST live outside the repository. Node resolution
//      walks up the directory tree, so a temp dir inside the repo finds the
//      repo's own node_modules — every entry then "loads fine" because the dev
//      dependencies are visible, and the test proves nothing.
//   2. Assertions about an entry that SHOULD fail must match the specific
//      missing module. Running `node -e` through a shell mangles the quoting
//      into a SyntaxError, which a bare try/catch misreads as the expected
//      failure.
//   3. Every scenario asserts up front which packages are absent, so a change
//      in npm's install behaviour surfaces as a failure rather than a false pass.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const workspace = mkdtempSync(join(tmpdir(), 'sendrail-install-'));
const tarballDir = join(workspace, 'tarball');
mkdirSync(tarballDir, { recursive: true });

const sh = process.platform === 'win32';

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: sh });
}

/** Run a script file and report success plus stderr, rather than throwing. */
function tryNode(file, cwd) {
  try {
    execFileSync(process.execPath, [file], { cwd, stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, stderr: '' };
  } catch (error) {
    return { ok: false, stderr: `${error.stderr ?? ''}${error.stdout ?? ''}` };
  }
}

function fail(message) {
  throw new Error(message);
}

/**
 * A scratch project outside the repo with the tarball plus `extraDeps` installed,
 * and nothing else.
 */
function scenario(name, tarball, extraDeps, mustBeAbsent) {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `smoke-${name}`, version: '1.0.0', private: true }, null, 2)
  );

  npm(['install', '--omit=peer', '--no-audit', '--no-fund', tarball, ...extraDeps], dir);

  const installed = readdirSync(join(dir, 'node_modules'));
  for (const absent of mustBeAbsent) {
    if (installed.includes(absent)) {
      fail(`[${name}] ${absent} is present — the isolation this scenario depends on is broken`);
    }
  }
  // Nothing may leak in from a parent directory either.
  if (existsSync(join(root, 'node_modules', '@aws-sdk')) && dir.startsWith(root)) {
    fail(`[${name}] scratch project is inside the repo; parent node_modules would leak in`);
  }

  return dir;
}

function expectLoads(dir, label, entries) {
  writeFileSync(
    join(dir, 'load.cjs'),
    `${entries.map((e) => `require(${JSON.stringify(e)});`).join('\n')}\n`
  );
  writeFileSync(
    join(dir, 'load.mjs'),
    `${entries.map((e) => `await import(${JSON.stringify(e)});`).join('\n')}\n`
  );

  for (const file of ['load.cjs', 'load.mjs']) {
    const result = tryNode(join(dir, file), dir);
    if (!result.ok) {
      fail(`[${label}] ${file}: ${entries.join(', ')} failed to load.\n${result.stderr}`);
    }
  }
  console.log(`[${label}] ${entries.join(', ')} load (CJS and ESM)`);
}

function expectMissingModule(dir, label, entry, peer) {
  const file = join(dir, `needs-${entry.replace(/\W/g, '-')}.cjs`);
  writeFileSync(file, `require(${JSON.stringify(entry)});\n`);

  const result = tryNode(file, dir);
  if (result.ok) {
    fail(`[${label}] ${entry} loaded without ${peer} — that dependency split is not real`);
  }
  if (!result.stderr.includes(`Cannot find module '${peer}'`)) {
    fail(
      `[${label}] ${entry} failed, but not because ${peer} is missing. This assertion is not testing what it claims.\n${result.stderr}`
    );
  }
  console.log(`[${label}] ${entry} correctly requires ${peer}`);
}

try {
  npm(['pack', '--pack-destination', tarballDir], root);
  const packed = readdirSync(tarballDir).find((f) => f.endsWith('.tgz'));
  if (!packed) {
    fail('npm pack produced no tarball');
  }
  const tarball = join(tarballDir, packed);

  // ── Scenario 1: nothing but the package ────────────────────────────────────
  // Core must work for a consumer who installs sendrail and nothing else.
  const bare = scenario('bare', tarball, [], ['@aws-sdk', '@nestjs', 'express', 'vitest']);
  expectLoads(bare, 'bare', ['sendrail']);
  expectMissingModule(bare, 'bare', 'sendrail/ses', '@aws-sdk/client-sesv2');
  expectMissingModule(bare, 'bare', 'sendrail/nest', '@nestjs/common');
  expectMissingModule(bare, 'bare', 'sendrail/express', 'express');
  expectMissingModule(bare, 'bare', 'sendrail/testing', 'vitest');

  // ── Scenario 2: NestJS, no AWS ─────────────────────────────────────────────
  // The important one. A NestJS host on SMTP or the logging transport must not
  // be forced to install the AWS SDK — the module reaches SES only through a
  // lazy import('sendrail/ses') taken when transport.kind === 'ses'.
  const nest = scenario(
    'nest-without-aws',
    tarball,
    ['@nestjs/common@^10', 'reflect-metadata@^0.2', 'rxjs@^7'],
    ['@aws-sdk']
  );
  expectLoads(nest, 'nest-without-aws', ['sendrail', 'sendrail/nest']);

  // ── Scenario 3: Express, no AWS and no NestJS ──────────────────────────────
  const express = scenario('express-only', tarball, ['express@^5'], ['@aws-sdk', '@nestjs']);
  expectLoads(express, 'express-only', ['sendrail', 'sendrail/express']);

  console.log('\ninstall smoke test passed');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
