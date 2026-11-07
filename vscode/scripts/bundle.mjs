// Copies the byond-devtools core (../src) into ./core so the .vsix is self-contained.
import { cp, rm } from 'node:fs/promises';
await rm('core', { recursive: true, force: true });
await cp('../src', 'core', { recursive: true });
await cp('../LICENSE', 'LICENSE');
console.log('bundled ../src into core/');
