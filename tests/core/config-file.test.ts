// PURPOSE: Tests for readConfigFile / readConfigFileSync — YAML and JSON parsing by extension
// PURPOSE: Verifies unsupported extensions and malformed files fail with the path (and line) in the error

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigFile, readConfigFileSync, ConfigFileError } from '../../src/core/config-file.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mandible-config-file-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(name: string, contents: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, contents, 'utf-8');
  return path;
}

describe('readConfigFile', () => {
  it('parses a .yaml file into a plain object', async () => {
    const path = await write('config.yaml', [
      'colony: ladder-condor',
      'poll_interval: 30',
      'labels:',
      '  - ready',
      '  - triaged',
      'model:',
      '  tier: sonnet',
    ].join('\n'));

    const config = await readConfigFile<{ colony: string; poll_interval: number; labels: string[]; model: { tier: string } }>(path);
    expect(config).toEqual({
      colony: 'ladder-condor',
      poll_interval: 30,
      labels: ['ready', 'triaged'],
      model: { tier: 'sonnet' },
    });
  });

  it('treats .yml the same as .yaml', async () => {
    const path = await write('config.yml', 'enabled: true\n');
    expect(await readConfigFile(path)).toEqual({ enabled: true });
  });

  it('matches the extension case-insensitively', async () => {
    const path = await write('CONFIG.YAML', 'enabled: true\n');
    expect(await readConfigFile(path)).toEqual({ enabled: true });
  });

  it('parses a .json file into a plain object', async () => {
    const path = await write('config.json', JSON.stringify({ colony: 'ladder-condor', poll_interval: 30 }));
    expect(await readConfigFile(path)).toEqual({ colony: 'ladder-condor', poll_interval: 30 });
  });

  it('rejects an unknown extension, naming the path and the supported extensions', async () => {
    const path = await write('config.toml', 'colony = "ladder-condor"\n');
    const err = await readConfigFile(path).catch(e => e);
    expect(err).toBeInstanceOf(ConfigFileError);
    expect(err.path).toBe(path);
    expect(err.message).toContain(path);
    expect(err.message).toContain('.yaml, .yml, .json');
  });

  it('rejects an unknown extension before touching the filesystem', async () => {
    const missing = join(root, 'does-not-exist.ini');
    await expect(readConfigFile(missing)).rejects.toThrow(ConfigFileError);
  });

  it('reports malformed YAML with the file and line', async () => {
    const path = await write('config.yaml', [
      'colony: ladder-condor',
      'labels:',
      '  - ready',
      '  bad: [unclosed',
    ].join('\n'));

    const err = await readConfigFile(path).catch(e => e);
    expect(err).toBeInstanceOf(ConfigFileError);
    expect(err.path).toBe(path);
    expect(err.line).toBeGreaterThanOrEqual(3);
    expect(err.message).toContain(`${path}:${err.line}`);
    expect(err.message).toMatch(/YAML/);
  });

  it('reports malformed JSON with the file and line when the parser gives a position', async () => {
    // Trailing comma: V8 reports a position for this one (not for every JSON error).
    const path = await write('config.json', '{\n  "colony": "ladder-condor",\n  "poll_interval": 30,\n}\n');

    const err = await readConfigFile(path).catch(e => e);
    expect(err).toBeInstanceOf(ConfigFileError);
    expect(err.path).toBe(path);
    expect(err.line).toBe(4);
    expect(err.message).toContain(`${path}:4`);
  });

  it('still names the file when a JSON error carries no position', async () => {
    const path = await write('config.json', '{\n  "poll_interval": ,\n}\n');
    const err = await readConfigFile(path).catch(e => e);
    expect(err).toBeInstanceOf(ConfigFileError);
    expect(err.message).toContain(path);
  });

  it('passes through a missing-file error from the filesystem', async () => {
    await expect(readConfigFile(join(root, 'missing.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('readConfigFileSync', () => {
  it('parses YAML and JSON synchronously', async () => {
    const yamlPath = await write('config.yaml', 'colony: ladder-condor\n');
    const jsonPath = await write('config.json', '{"colony":"ladder-condor"}');
    expect(readConfigFileSync(yamlPath)).toEqual({ colony: 'ladder-condor' });
    expect(readConfigFileSync(jsonPath)).toEqual({ colony: 'ladder-condor' });
  });

  it('throws the same ConfigFileError for malformed files', async () => {
    const path = await write('config.yml', 'a: [unclosed\n');
    expect(() => readConfigFileSync(path)).toThrow(ConfigFileError);
    expect(() => readConfigFileSync(path)).toThrow(path);
  });
});
