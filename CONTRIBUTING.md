# Contributing to Canton Streams

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating. If you are reporting a security issue, do not open a public issue or PR; follow [SECURITY.md](SECURITY.md) instead.

## Development setup

### Prerequisites

- **Node.js** >= 22.14
- **pnpm** >= 9.15 (`corepack enable && corepack prepare pnpm@9.15.0 --activate`)
- **Daml SDK** 3.4.10 (for Daml template development)
- **Docker** (for Canton sandbox)

### Install and build

```bash
pnpm install
pnpm build          # build all packages via Turbo
```

### Development workflow

```bash
pnpm dev            # start proxy + dashboard in watch mode

# Or run individually:
cd packages/proxy && pnpm dev      # proxy with tsx watch
cd packages/dashboard && pnpm dev  # Vite dev server
```

### Daml development

```bash
pnpm daml:deps      # download dependency DARs
pnpm daml:build     # compile all Daml packages
pnpm daml:test      # run Daml scenario tests
```

## Project structure

```
Canton-Streams/
  packages/
    daml/             # Daml smart contracts
      interfaces/     # Shared type definitions (StreamConfig, etc.)
      main/           # Escrow templates, workflows, settlement adapters
    sdk/              # TypeScript SDK
      src/
        transport/    # gRPC and JSON API transports
        commands/     # create, accept, withdraw, cancel, renew, query
        accrual/      # vesting calculation (pure math)
        types/        # TypeScript type definitions
        utils/        # errors, validation, logging
    proxy/            # Express REST proxy
    dashboard/        # React + Vite SPA
  docker/             # Docker build files
  docs/               # Documentation
```

## Code style

- **TypeScript:** ESLint + Prettier. Run `pnpm lint` before committing.
- **Daml:** Follow existing module naming conventions (`CantonStreams.Stream.*`, `CantonStreams.Workflow.*`, `CantonStreams.Settlement.*`).
- Use meaningful names. Avoid abbreviations except well-known ones (CID, DAR, JWT, etc.).
- All exported functions and types need JSDoc comments.
- Prefer `readonly` on interface fields.

## Testing

```bash
pnpm test           # run all TypeScript tests (vitest)
pnpm daml:test      # run all Daml scenario tests
```

### Writing tests

- **SDK tests:** `packages/sdk/src/__tests__/` using vitest
- **Proxy tests:** `packages/proxy/src/__tests__/` using vitest
- **Dashboard tests:** `packages/dashboard/src/__tests__/` using vitest
- **Daml tests:** scenario functions in Daml modules

## Pull request process

1. Create a feature branch from `main`
2. Make your changes with clear, atomic commits
3. Run `pnpm lint && pnpm test` locally
4. Open a PR with:
   - Clear title describing the change
   - Description of what and why
   - Link to any related issues
5. Address review feedback
6. Squash-merge when approved

## Releases

The tag format, versioning policy, and npm publish workflow are documented in [RELEASING.md](RELEASING.md).

## Template registry

When adding new Daml templates, register them in `packages/sdk/src/templates.ts`:
1. Add the `TemplateId` export with package ID, module name, and entity name
2. Add choice name constants
3. Add to template groups (`ESCROW_TEMPLATES`, `CREATE_REQUEST_TEMPLATES`) if applicable
4. Update `validateTemplateRegistry()` if the template should be validated at startup

## Adding a new settlement mode

1. Add the mode to `SettlementMode` enum in both Daml (`Types.daml`) and SDK (`stream.ts`)
2. Create the escrow template in `packages/daml/main/daml/CantonStreams/Stream/`
3. Create the workflow template in `packages/daml/main/daml/CantonStreams/Workflow/`
4. Create or reuse a settlement adapter in `packages/daml/main/daml/CantonStreams/Settlement/`
5. Register templates and choices in `templates.ts`
6. Add dispatch cases in SDK command files (`create.ts`, `accept.ts`, `withdraw.ts`, `cancel.ts`, `renew.ts`)
7. Update proxy routes if needed
8. Add dashboard UI support (create form fields, detail view)
