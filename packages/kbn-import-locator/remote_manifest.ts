/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { getRemoteManifestPaths } from '@kbn/repo-packages';

export interface RemoteModule {
  readonly modulePath: string;
  readonly exportName: string;
}

export interface RemoteCapability extends RemoteModule {
  readonly token: string;
  readonly placement: 'coordinator' | 'executor';
  readonly scope: 'worker' | 'run';
  readonly needs: readonly string[];
}

export interface RemoteManifest {
  readonly taskTypes?: readonly RemoteModule[];
  readonly contributions?: Readonly<Record<string, readonly RemoteModule[]>>;
  readonly capabilities?: Readonly<Record<string, RemoteCapability>>;
}

type Data = string | readonly Data[] | { readonly [key: string]: Data };

/** Reads convention-discovered manifest data without importing or executing plugin code. */
export const interpretRemoteManifest = (file: string): RemoteManifest => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const invalid = (): never => {
    throw new Error(`Invalid static remote manifest: ${file}`);
  };
  const read = (node: ts.Node): Data => {
    if (ts.isAsExpression(node) && node.type.getText(source) === 'const')
      return read(node.expression);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(read);
    if (ts.isObjectLiteralExpression(node)) {
      return Object.fromEntries(
        node.properties.map((property) => {
          if (!ts.isPropertyAssignment(property)) return invalid();
          const name = property.name;
          if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return invalid();
          return [name.text, read(property.initializer)];
        })
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'require.resolve' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      return createRequire(file).resolve(node.arguments[0].text);
    }
    return invalid();
  };
  const [statement] = source.statements;
  if (
    source.statements.length !== 1 ||
    !ts.isVariableStatement(statement) ||
    !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    statement.declarationList.flags !== ts.NodeFlags.Const
  )
    return invalid();
  const [declaration] = statement.declarationList.declarations;
  if (
    statement.declarationList.declarations.length !== 1 ||
    declaration.name.getText(source) !== 'remote' ||
    !declaration.initializer
  )
    return invalid();
  // Syntax is restricted before interpreting the data; no evaluation, imports or factories.
  return read(declaration.initializer) as RemoteManifest;
};

/** Discovers contribution declarations without importing the owning plugins. */
export const getRemoteContributions = (
  repoRoot: string,
  key: string
): Array<RemoteModule & { readonly directory: string }> =>
  getRemoteManifestPaths(repoRoot).flatMap(({ directory, path }) =>
    (interpretRemoteManifest(path).contributions?.[key] ?? []).map((module) => ({
      directory,
      ...module,
    }))
  );
