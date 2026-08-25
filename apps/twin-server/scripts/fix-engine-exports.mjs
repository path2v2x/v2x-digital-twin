#!/usr/bin/env node
/**
 * The engine packages are consumed via pnpm file: deps, which copy only their
 * published files (dist/). Their exports maps still list a "development"
 * condition pointing at src/index.ts, which vite/vitest would resolve and
 * fail on. Strip dangling development conditions from every installed copy
 * (top-level and transitive .pnpm copies). Runs as postinstall; idempotent.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function fixPackage(pkgDir) {
  const pkgJson = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgJson)) return;
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  let changed = false;
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (typeof entry.development === 'string' && !existsSync(path.join(pkgDir, entry.development))) {
      delete entry.development;
      changed = true;
    }
    for (const value of Object.values(entry)) visit(value);
  };
  visit(pkg.exports);
  if (changed) {
    writeFileSync(pkgJson, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[fix-engine-exports] stripped dangling development condition: ${pkg.name} (${pkgDir})`);
  }
}

const pnpmDir = path.resolve('node_modules', '.pnpm');
if (existsSync(pnpmDir)) {
  for (const entry of readdirSync(pnpmDir)) {
    const scope = path.join(pnpmDir, entry, 'node_modules', '@simforge');
    if (!existsSync(scope)) continue;
    for (const name of readdirSync(scope)) fixPackage(path.join(scope, name));
  }
}
