import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { styleText } from 'node:util';

interface ProtocolJsonSchemaModule {
  readonly createProtocolJsonSchema: () => unknown;
}

const packageDirectory = join(import.meta.dirname, '..');
const generatedModulePath = join(packageDirectory, 'dist', 'protocol-json-schema.js');
const generatedModule = await import(pathToFileURL(generatedModulePath).href) as ProtocolJsonSchemaModule;
const protocolJsonSchema = generatedModule.createProtocolJsonSchema();

if (protocolJsonSchema === null || typeof protocolJsonSchema !== 'object' || Array.isArray(protocolJsonSchema)) {
  throw new TypeError('Protocol JSON Schema generation must return an object');
}

const outputPath = join(packageDirectory, 'dist', 'protocol.schema.json');
await writeFile(outputPath, `${JSON.stringify(protocolJsonSchema, null, 2)}\n`, 'utf8');
await Promise.all([
  rm(join(packageDirectory, 'dist', 'protocol-json-schema.d.ts'), { force: true }),
  rm(join(packageDirectory, 'dist', 'protocol-json-schema.d.ts.map'), { force: true }),
  rm(join(packageDirectory, 'dist', 'protocol-json-schema.js'), { force: true }),
  rm(join(packageDirectory, 'dist', 'protocol-json-schema.js.map'), { force: true }),
]);

console.info(styleText('green', '✅ [schema]'), 'generated', outputPath);
