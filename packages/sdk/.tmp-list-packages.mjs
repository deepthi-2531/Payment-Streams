import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';

const token = process.env.PROXY_DEFAULT_TOKEN;
if (!token) {
  console.error('PROXY_DEFAULT_TOKEN is required');
  process.exit(1);
}

const protoDir = path.resolve(process.cwd(), '..', '..', 'proto');
const packageDef = protoLoader.loadSync(
  [path.join(protoDir, 'com/daml/ledger/api/v2/package_service.proto')],
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
const PackageService = grpcObj.com.daml.ledger.api.v2.PackageService;
const metadata = new grpc.Metadata();
metadata.set('authorization', `Bearer ${token}`);

const client = new PackageService('127.0.0.1:5001', grpc.credentials.createInsecure());
client.listPackages({}, metadata, (err, response) => {
  if (err) {
    console.error(`ERR ${err.code} ${err.message}`);
    process.exit(1);
  }
  const ids = response.package_ids || [];
  console.log(`count ${ids.length}`);
  for (const id of ids) {
    console.log(id);
  }
  process.exit(0);
});
