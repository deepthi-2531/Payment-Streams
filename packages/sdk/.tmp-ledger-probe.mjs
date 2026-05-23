import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';

const token = process.env.PROXY_DEFAULT_TOKEN;
const parties = String(process.env.ACT_AS_PARTIES || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

if (!token) {
  console.error('PROXY_DEFAULT_TOKEN is required');
  process.exit(1);
}
if (parties.length === 0) {
  console.error('ACT_AS_PARTIES is required');
  process.exit(1);
}

const protoDir = path.join(process.cwd(), 'proto');
const packageDef = protoLoader.loadSync(
  [
    path.join(protoDir, 'com/daml/ledger/api/v2/state_service.proto'),
  ],
  {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  },
);

const grpcObj = grpc.loadPackageDefinition(packageDef);
const StateService = grpcObj.com.daml.ledger.api.v2.StateService;
const metadata = new grpc.Metadata();
metadata.set('authorization', `Bearer ${token}`);

const client = new StateService('127.0.0.1:5001', grpc.credentials.createInsecure());

function getLedgerEnd() {
  return new Promise((resolve, reject) => {
    client.getLedgerEnd({}, metadata, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

function getActiveContracts() {
  return new Promise((resolve) => {
    const filtersByParty = Object.fromEntries(
      parties.map((party) => [party, { cumulative: [{ wildcard_filter: {} }] }]),
    );
    const stream = client.getActiveContracts(
      {
        event_format: {
          filters_by_party: filtersByParty,
          verbose: true,
        },
      },
      metadata,
    );
    const counts = new Map();
    let total = 0;

    stream.on('data', (response) => {
      const created = response?.contract_entry?.active_contract?.created_event;
      const templateId = created?.template_id;
      if (!templateId) return;
      const key = `${templateId.module_name}:${templateId.entity_name}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    });
    stream.on('end', () => {
      resolve({ total, counts: [...counts.entries()].sort((a, b) => b[1] - a[1]) });
    });
    stream.on('error', (err) => {
      resolve({ error: `${err.code ?? ''} ${err.message}`.trim(), total, counts: [...counts.entries()] });
    });
  });
}

const ledgerEnd = await getLedgerEnd();
console.log(JSON.stringify({ ledgerEnd }, null, 2));

const active = await getActiveContracts();
console.log(JSON.stringify({ parties, active }, null, 2));
