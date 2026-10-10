import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import extension from '../index.js';
import computerBoardExtension from '../extension/index.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

describe('pi package entry', () => {
  it('loads only the root index so Pi displays the package name without a directory suffix', () => {
    expect(manifest.pi.extensions).toEqual(['./index.ts']);
    expect(manifest.files).toContain('index.ts');
    expect(manifest.files).toContain('extension');
  });

  it('re-exports the existing extension factory', () => {
    expect(extension).toBe(computerBoardExtension);
  });
});
