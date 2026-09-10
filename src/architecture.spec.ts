import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Module specifiers a file imports AT RUNTIME.
 *
 * Parsed with the TypeScript AST rather than matched with a regex, for two
 * reasons that both bit a earlier draft of this test: prose inside a string
 * literal can contain `from '...'` (the core transport factory's error message
 * names `sendrail/ses`), and `import type` erases at compile time so it must not
 * count as a dependency.
 */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  );

  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return specifiers;
}

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Every bare specifier reachable from an entry by following relative imports. */
function bareImportsReachableFrom(entry: string): Set<string> {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    for (const specifier of runtimeImports(file)) {
      const relative = resolveRelative(specifier, file);
      if (relative) {
        queue.push(relative);
      } else {
        bare.add(specifier);
      }
    }
  }

  return bare;
}

function matches(specifier: string, forbidden: string): boolean {
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

/**
 * The packaging invariant, enforced at the source level.
 *
 * A consumer on SMTP must not be made to install the AWS SDK, and an Express
 * host must never resolve `@nestjs/common`. Both are easy to break by adding one
 * innocuous-looking re-export to a barrel, and neither breaks a test or a build
 * when it happens — the cost lands on someone else's `npm install`.
 *
 * This walks the real import graph rather than trusting the exports map. The
 * install smoke test in CI checks the same property against a packed tarball;
 * this one fails in a second and points at the file.
 */
describe('entry point dependency isolation', () => {
  it('core pulls neither AWS, NestJS nor Express', () => {
    const bare = [...bareImportsReachableFrom('src/index.ts')];

    for (const forbidden of [
      '@aws-sdk/client-ses',
      '@aws-sdk/client-sesv2',
      '@nestjs/common',
      'express',
    ]) {
      expect(bare.filter((s) => matches(s, forbidden))).toEqual([]);
    }
  });

  it('core depends only on node builtins and the two runtime deps', () => {
    const bare = [...bareImportsReachableFrom('src/index.ts')].filter((s) => !s.startsWith('node:'));

    // The mail-composer specifier ends in /index.js deliberately — ESM cannot
    // import a directory. See the comment in transport/mime.ts.
    expect(bare.sort()).toEqual([
      'html-to-text',
      'nodemailer',
      'nodemailer/lib/mail-composer/index.js',
    ]);
  });

  it('the nest entry does not eagerly pull AWS', () => {
    const bare = [...bareImportsReachableFrom('src/nest.ts')];

    // 'sendrail/ses' is reached only through a dynamic import, so it is a bare
    // specifier here rather than a walked file — which is exactly the point.
    expect(bare.filter((s) => s.startsWith('@aws-sdk/'))).toEqual([]);
    expect(bare).toContain('sendrail/ses');
  });

  it('the express entry does not pull AWS or NestJS', () => {
    const bare = [...bareImportsReachableFrom('src/express.ts')];

    expect(bare.filter((s) => s.startsWith('@aws-sdk/'))).toEqual([]);
    expect(bare.filter((s) => s.startsWith('@nestjs/'))).toEqual([]);
    expect(bare).toContain('express');
  });
});
