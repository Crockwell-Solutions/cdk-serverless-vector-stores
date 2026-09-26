# CDK Serverless Vector Stores

## Architecture

The application is composed of three CDK stacks deployed in order via CodePipeline:

1. **StatefulStack** — VPC, DynamoDB tables, Cognito User Pool, SSM parameters
2. **StatelessStack** — API Gateway (Cognito-authorised), Lambda functions 
3. **FrontendStack** — S3 + CloudFront hosting for the React SPA, with runtime config injection at deploy time

Stages: `local`, `dev`, `staging` and `prod` — configured in `config/environment-config.ts`.

## Project Structure

```text
├── bin/                          # CDK app entry point
├── config/                       # Environment & pipeline configuration
│   ├── types.ts                  # Enums: Region, Stage
│   ├── environment-config.ts     # Per-stage config (dev/prod) & defaults
│   ├── pipeline-config.ts        # CodePipeline settings (repo, branches, accounts)
│   └── index.ts                  # Barrel export
├── lib/                          # CDK infrastructure stacks
│   ├── constructs/               # Reusable constructs (CustomLambda, CustomTable)
│   ├── frontend/                 # FrontendStack: S3 + CloudFront + config.js deploy
│   ├── stateful/                 # StatefulStack: DynamoDB, Cognito, VPC, SSM params
│   ├── stateless/                # StatelessStack: API Gateway, Lambdas, ECS Fargate
│   ├── utils/                    # Helpers (project root path)
│   ├── application-stage.ts      # CDK Stage composing all stacks
│   └── pipeline-stack.ts         # CodePipeline V2 with GitHub source
├── src/                          # Application source code
│   ├── api/                      # Lambda handlers for API
│   ├── shared/                   # Shared TS utilities (logger, consts, utils)
└── frontend/                     # React SPA (Vite + Tailwind CSS)
    └── src/
        ├── auth/                 # Cognito auth context & runtime config
        ├── components/           # Layout, navigation components
        └── pages/                # Route pages (Dashboard, AlertCriteria, etc.)
```

## Prerequisites

- Node.js 22+ (CDK and Lambda functions)
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

## Getting Started

Install dependencies:

```bash
npm install
```

Build and synthesise CloudFormation templates:

```bash
npm run build
npm run synth
```

## Development Approach

Each developer maintains their own isolated AWS environment, deployed via cdk deploy. This allows for quick iteration and for changes to be made without impacted the deployed environments. Feature branches are worked on independently in per-developer stacks, then merged to main. Once changes are merged into main, they are deployed to the managed environments (currently just Dev / Preprod, and in the future a production environment).

There are two different ways to deploy and work with this project.
1. Deploy to staging (and eventually production) through the CDK Pipeline(s). Make changes in this repo and merge into `main` for standard pipeline based deployment to the target account(s).
2. Deploy some of the resources to a "Local" account and use those for testing before merging changes into `main`.

To work with a "local" AWS account, deploy the resources directly to that account with the command:

```bash
cdk deploy "Local/*" --require-approval never
```

The way of working in this method is then:

1. Deploy resource
2. Run Lambda functions locally, whilst connecting to your "local" AWS account. You can use "AWS SAM" to run the Lambda functions locally, whilst still connecting to remote resources. This is handled through the configuration of vscode's launch.json (`.vscode/launch.json`)
3. Configure the `frontend/public/config.js` file and run the frontend locally (see below)
4. Make changes and re-deploy to your local AWS account to iterate

## Frontend

The frontend is a React 19 SPA using Vite, Tailwind CSS 4, and react-router-dom v7. Authentication is handled directly via `amazon-cognito-identity-js`.

Runtime configuration (API URL, Cognito settings) is injected at deploy time via `window.__RUNTIME_CONFIG__` in `config.js`, not baked into the build. For local development, copy the example config:

```bash
cp frontend/public/config.js.example frontend/public/config.js
```

Then start the dev server:

```bash
cd frontend
npm install
npm run dev
```

## CI/CD Pipeline

Deployment is managed by AWS CodePipeline V2, defined in `lib/pipeline-stack.ts`. The pipeline:

- Sources from the repo on GitHub via CodeStar Connections
- Runs `npm ci`, `npm run build`, `npx cdk synth` in the synth step
- Deploys the `ApplicationStage` (all three stacks) to the target account
- Supports optional manual approval gates per stage

Pipeline configuration lives in `config/pipeline-config.ts`.

## Commands

### Infrastructure (root)

| Command | Description |
|---|---|
| `npm install` | Install CDK/backend dependencies |
| `npm run build` | Compile TypeScript |
| `npm run synth` | Synthesise all CloudFormation stacks |
| `npm run test` | Run Jest unit tests |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npx cdk deploy --all` | Deploy all stacks |
| `npx cdk diff` | Diff deployed vs local |

### Frontend (`frontend/`)

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | TypeScript check + Vite production build |
| `npm run lint` | Lint frontend code |
