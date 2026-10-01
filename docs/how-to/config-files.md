# Config Files

A colony's settings — which labels to sense, how often to poll, which model tier to use — usually belong in a file next to the colony code, not in the code itself. Mandible ships a small reader so colony code never needs to bring its own YAML parser. It's part of the framework (`@mandible-ai/mandible`), so it is available wherever colony code runs, including inside a cloud zone.

```typescript
import { readConfigFile } from '@mandible-ai/mandible';

const config = await readConfigFile<MyConfig>('./config.yaml');
```

## Formats

The parser is chosen by extension:

| Extension | Parser |
|---|---|
| `.yaml`, `.yml` | [`yaml`](https://eemeli.org/yaml/) (YAML 1.2) |
| `.json` | `JSON.parse` |

Anything else throws a `ConfigFileError` naming the path and the supported extensions.

## Example: a colony reading `config.yaml`

```yaml
# config.yaml
signals: ./.mandible/signals
sense: task:ready
model: sonnet
concurrency: 2
lease_ms: 30000
```

```typescript
import { mandible, FilesystemEnvironment, readConfigFile } from '@mandible-ai/mandible';
import { withClaudeCode } from '@mandible-ai/mandible/providers';

interface ColonyConfig {
  signals: string;
  sense: string;
  model: string;
  concurrency: number;
  lease_ms: number;
}

const config = await readConfigFile<ColonyConfig>(new URL('./config.yaml', import.meta.url).pathname);

await mandible('ladder')
  .environment(new FilesystemEnvironment({ root: config.signals }))
  .colony('worker', c => c
    .sense(config.sense, { unclaimed: true })
    .do('work', withClaudeCode({ model: config.model, prompt: s => `Handle: ${JSON.stringify(s.payload)}` }))
    .concurrency(config.concurrency)
    .claim('lease', config.lease_ms)
  )
  .start();
```

Resolve the path relative to the module (as above) rather than the process's working directory, so the colony finds its file regardless of where it was launched from.

`readConfigFileSync` does the same thing synchronously, for module-scope loading where `await` is awkward.

## Types are a cast, not a check

`readConfigFile<T>()` returns whatever the file contains, typed as `T`. It does not validate. If the file can be edited by someone other than the colony's author, check the shape — for example with zod:

```typescript
const ColonyConfig = z.object({ sense: z.string(), concurrency: z.number().int().positive() });
const config = ColonyConfig.parse(await readConfigFile('./config.yaml'));
```

## Errors

Parse failures throw `ConfigFileError` with `path`, and `line` / `column` (1-based) when the parser reports a position. The message includes `path:line:column`, so it's clickable in most terminals:

```
ConfigFileError: Failed to parse YAML config /app/config.yaml:4:1: All mapping items must start at the same column at line 4, column 1:

  - ready
  bad: [unclosed
^
```

YAML syntax errors carry a position. JSON errors carry one when V8 reports it (most syntax errors, though not every one). A missing file surfaces the underlying `ENOENT` error unchanged.
