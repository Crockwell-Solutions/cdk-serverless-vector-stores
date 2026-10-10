# Cost model and controls

The goal is **near-zero idle cost**, not free storage or free experimentation. No fixed monthly cost estimate is hardcoded: prices depend on region, date, account offers and usage. Verify current Ireland rates in the linked AWS pricing pages before a large run.

| Component            | Active charges to consider                                                    | Idle behavior                                                                     |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| OpenSearch NextGen   | Indexing/search OCU seconds; index storage                                    | Compute stops after 10 minutes without collection-group traffic; storage persists |
| S3 Vectors           | Vector puts, queries/processing, stored vector and metadata bytes             | Stored bytes remain billed                                                        |
| DynamoDB             | Table writes, vector index writes/search request bytes, table/index storage   | No provisioned read/write or compute floor                                        |
| Ordinary S3          | Rendered page images; PUT/GET requests                                        | Object storage persists                                                           |
| Bedrock              | Text embedding tokens, vision input/output, answer input/output               | No calls means no model inference charge                                          |
| Supporting resources | CloudWatch metric reads, cleanup Lambda execution/logs, CDK bootstrap storage | No scheduled invocations or custom metrics are created                            |

OpenSearch's two-OCU maximum per component is a capacity cap, **not a monetary budget**. A sustained workload can keep four combined OCUs active. The idle timeout extends billable active time beyond the last query. Other collections in the same group can prevent sleep; this stack creates a dedicated group.

The raw storage lower bound for 1,024-dimensional float32 vectors is `record_count × 1,024 × 4` bytes **per store**, before metadata, text, replicas/index overhead, DynamoDB encoding and ordinary S3 images. It is not the billed size. Caption chunks increase record count. The source PDF is kept local.

## Before spending

Run `lab prepare` and `lab plan`. The plan displays document pages, source text chunks, estimated text tokens, possible vision calls and raw vector bytes. The characters/4 token estimate is approximate and excludes image tokens/captions. The bundled document contains nine pages and preparation processes all of them. Embedding guards default to 300 source text chunks and 20 image pages; increasing them is an explicit choice. Image descriptions use a maximum of 1,600 output tokens and answers 1,200.

Caches are keyed by content and model settings. Shared cached embeddings prevent paying three times for the same corpus. Failed runs can be resumed. Do not remove `.vector-lab/cache` unnecessarily. Regenerating visual captions can change retrieval quality, so keep them with the experiment.

`lab usage` sums actual returned tokens from successfully logged Bedrock invocations. The log contains operation/model/counts, not prompt content or credentials. It excludes calls from other machines and failures before the usage response was logged. Use AWS billing for authoritative cost.

For a run-level estimate, multiply observed embedding/vision/answer tokens by the applicable per-token prices, vector/table operations or request bytes by service rates, measured OpenSearch OCU-seconds by its regional hourly rate divided by 3,600, and persisted GB by monthly storage rates over the retained fraction of the month. Those dimensions differ by backend: do not price every operation as a simple flat query charge. The retrieved DynamoDB consumed-capacity structure is saved with benchmark samples where returned.

## Stop recurring cost

Stop queries and let OpenSearch sleep. Use `lab metrics` to observe OCU history; avoid periodic data-plane pings. Run `npm run destroy` to remove the demo infrastructure and its data. Account-level CDK bootstrap resources are separate and are not removed by this command.

## Pricing references

- [OpenSearch Serverless NextGen pricing](https://aws.amazon.com/opensearch-service/pricing/)
- [S3 pricing, including S3 Vectors](https://aws.amazon.com/s3/pricing/)
- [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)
- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
