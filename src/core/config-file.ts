// PURPOSE: Read a colony's settings file (YAML or JSON) into a plain object.
// PURPOSE: Lives in the framework so colony code in a zone never needs its own parser.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';

const SUPPORTED_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/**
 * Thrown when a config file cannot be parsed or has an unsupported extension.
 * `line` and `column` are 1-based and set when the parser reports a position.
 */
export class ConfigFileError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

/**
 * Read and parse a config file, choosing the parser by extension:
 * `.yaml` / `.yml` → YAML, `.json` → JSON.
 *
 * The result is not validated — `T` is a cast, so check the shape
 * (e.g. with zod) if the file comes from outside the colony.
 */
export async function readConfigFile<T = unknown>(path: string): Promise<T> {
  const format = formatOf(path);
  const text = await readFile(path, 'utf-8');
  return parseConfig(text, format, path) as T;
}

/** Synchronous variant of {@link readConfigFile}, for module-scope config loading. */
export function readConfigFileSync<T = unknown>(path: string): T {
  const format = formatOf(path);
  const text = readFileSync(path, 'utf-8');
  return parseConfig(text, format, path) as T;
}

type ConfigFormat = 'yaml' | 'json';

function formatOf(path: string): ConfigFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.json') return 'json';
  throw new ConfigFileError(
    `Unsupported config file extension for ${path}: expected one of ${SUPPORTED_EXTENSIONS.join(', ')}`,
    path,
  );
}

function parseConfig(text: string, format: ConfigFormat, path: string): unknown {
  try {
    return format === 'yaml' ? parseYaml(text) : JSON.parse(text);
  } catch (err) {
    const { line, column } = positionOf(err, text);
    const where = line !== undefined ? `${path}:${line}${column !== undefined ? `:${column}` : ''}` : path;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigFileError(`Failed to parse ${format.toUpperCase()} config ${where}: ${reason}`, path, line, column);
  }
}

/** Best-effort 1-based line/column from a YAML or JSON parse error. */
function positionOf(err: unknown, text: string): { line?: number; column?: number } {
  if (err instanceof YAMLParseError && err.linePos) {
    return { line: err.linePos[0].line, column: err.linePos[0].col };
  }
  if (err instanceof SyntaxError) {
    // V8 reports "... at position N" (sometimes followed by "(line L column C)").
    const match = /line (\d+) column (\d+)/.exec(err.message);
    if (match) return { line: Number(match[1]), column: Number(match[2]) };
    const pos = /at position (\d+)/.exec(err.message);
    if (pos) {
      const before = text.slice(0, Number(pos[1])).split('\n');
      return { line: before.length, column: before[before.length - 1].length + 1 };
    }
  }
  return {};
}
