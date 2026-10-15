// PURPOSE: Keep the standalone colony API and public package imports in docs honest.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { generateRunnerScript } from '../../src/hosts/docker.js';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const documents = [
  'README.md',
  ...readdirSync(new URL('docs/how-to/', root)).filter(name => name.endsWith('.md')).map(name => `docs/how-to/${name}`),
];

describe('documented public APIs', () => {
  it.each(documents)('%s uses the one-argument standalone colony builder', file => {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const match of text.matchAll(/```(?:typescript|ts)\n([\s\S]*?)```/g)) {
      const source = ts.createSourceFile(file, match[1], ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'colony') {
          expect(node.arguments.length, `${file}: ${node.getText(source)}`).toBe(1);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  });

  it('the Docker runner imports only exported package entrypoints', () => {
    const source = ts.createSourceFile('runner.ts', generateRunnerScript({
      colonyName: 'worker', modulePath: 'worker.ts', exportName: 'configureWorker',
    }), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(pkg.name)) continue;
      const subpath = `.${specifier.slice(pkg.name.length)}`;
      expect(Object.hasOwn(pkg.exports, subpath), `Runner import is not exported: ${specifier}`).toBe(true);
    }
  });

  it('OpenCode is an optional peer, like other provider SDKs', () => {
    expect(pkg.peerDependencies['@opencode-ai/sdk']).toBeTypeOf('string');
    expect(pkg.peerDependenciesMeta['@opencode-ai/sdk']).toEqual({ optional: true });
  });
});
