// Runs the integration suite inside a real VS Code (stable or insiders: VSCODE_VERSION).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
const here = path.dirname(fileURLToPath(import.meta.url));
const version = process.env.VSCODE_VERSION || 'stable';
try {
  await runTests({ version, extensionDevelopmentPath: path.join(here, '..'), extensionTestsPath: path.join(here, 'suite', 'index.cjs'),
    launchArgs: [path.join(here, '..', '..', 'fixtures', 'render', 'project'), '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'] });
} catch (e) { console.error(`VS Code ${version} tests failed: ${e}`); process.exit(1); }
