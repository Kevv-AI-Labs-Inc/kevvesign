import path from 'node:path';
import { z } from 'zod';
import {
  seedState,
  type ManifestSigner,
  type ObjectStore,
  type PlatformRepository,
} from '@esign/domain';
import {
  AzureBlobObjectStore,
  AzureKeyVaultManifestSigner,
  AzureSqlStateRepository,
  HmacManifestSigner,
  JsonFileRepository,
  LocalObjectStore,
  PlatformEvidenceFinalizer,
} from '@esign/infrastructure';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  DATA_DIR: z.string().default('.data'),
  FINALIZATION_MESSAGE: z.string().optional(),
  ENVELOPE_ID: z.string().uuid().optional(),
  SESSION_SECRET: z.string().min(32).default('development-only-secret-change-me-now'),
  AZURE_SQL_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_URL: z.string().url().optional(),
  AZURE_STORAGE_CONTAINER: z.string().default('esign-objects'),
  AZURE_KEY_VAULT_URL: z.string().url().optional(),
  AZURE_MANIFEST_KEY_NAME: z.string().default('esign-manifest'),
});

const config = EnvironmentSchema.parse(process.env);
const message = config.FINALIZATION_MESSAGE
  ? (JSON.parse(Buffer.from(config.FINALIZATION_MESSAGE, 'base64').toString('utf8')) as {
      envelopeId: string;
    })
  : { envelopeId: config.ENVELOPE_ID };
const envelopeId = z.string().uuid().parse(message.envelopeId);

let repository: PlatformRepository;
let objects: ObjectStore;
let signer: ManifestSigner;

if (config.NODE_ENV === 'production') {
  repository = new AzureSqlStateRepository(
    z.string().min(1).parse(config.AZURE_SQL_CONNECTION_STRING),
  );
  objects = new AzureBlobObjectStore(
    z.string().url().parse(config.AZURE_STORAGE_ACCOUNT_URL),
    config.AZURE_STORAGE_CONTAINER,
  );
  signer = new AzureKeyVaultManifestSigner(
    z.string().url().parse(config.AZURE_KEY_VAULT_URL),
    config.AZURE_MANIFEST_KEY_NAME,
  );
} else {
  const dataDir = path.resolve(config.DATA_DIR);
  repository = new JsonFileRepository(path.join(dataDir, 'platform-state.json'), seedState);
  objects = new LocalObjectStore(path.join(dataDir, 'objects'));
  signer = new HmacManifestSigner(config.SESSION_SECRET);
}

await new PlatformEvidenceFinalizer(repository, objects, signer).finalize(envelopeId);
process.stdout.write(`${JSON.stringify({ status: 'completed', envelopeId })}\n`);
