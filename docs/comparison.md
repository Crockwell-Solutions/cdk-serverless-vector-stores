# Vector store comparison

AWS service documentation was reviewed on 26 September 2026; DynamoDB's CDK/CloudFormation vector-index support was rechecked on 8 October 2026. Service behavior, availability and pricing can change; preserve package versions and run configuration with your measurements.

| Topic                         | OpenSearch Serverless NextGen                                         | S3 Vectors                        | DynamoDB vector index                                     |
| ----------------------------- | --------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| API exercised                 | Signed OpenSearch bulk and kNN HTTP                                   | PutVectors / QueryVectors         | BatchWriteItem / SearchVectors                            |
| Idle compute                  | Zero floors; sleeps after 10 minutes without collection-group traffic | No provisioned compute            | On-demand table/index requests                            |
| Remaining idle cost           | Persisted index storage                                               | Vector storage                    | Table and index storage                                   |
| Application data              | Search documents and metadata                                         | Vector metadata                   | Operational items and vectors together                    |
| Query features                | Full-text and richer query DSL available; baseline here is kNN        | Vector query and metadata filters | Vector search with partition scoping and declared filters |
| Baseline filter               | Corpus, modality, page                                                | Corpus, modality, page            | Corpus HASH, modality/page INLINE_FILTER                  |
| Native score in this demo     | OpenSearch similarity, higher is better                               | Cosine distance, lower is better  | Cosine distance, lower is better                          |
| Bedrock embeddings + Converse | Implemented                                                           | Implemented                       | Implemented                                               |

All store integrations use SDK/service APIs and actual cloud vector indexes. The local exact search is only an evaluation baseline. No one backend is expected to win every dimension: use the measurements and feature requirements rather than assuming a latency ranking.

## Design choices

The OpenSearch collection belongs to a NEXTGEN group with zero minimum OCUs and a low maximum of two indexing plus two search OCUs. A Classic collection is not a cheaper substitute: it would violate the intended idle behavior. Standby replicas are enabled following the NextGen examples. The lab has one collection so an unrelated collection cannot keep its group awake.

The index mapping uses `space_type: cosinesimil` and 1x compression for the baseline. NextGen's default 32x compression would add a separate accuracy/cost variable. GPU index build acceleration is explicitly disabled for this small demo. Compression, GPU acceleration, and OpenSearch full-text/hybrid search would be useful separate experiments; the baseline does not claim to test them.

DynamoDB's vector index is declared in the CDK stack and created by CloudFormation during deployment. CDK's L2 `Table` remains in use; its underlying `CfnTable.vectorIndexes` property defines the 1,024-dimensional `COSINE` index over the `vector` attribute, with `ALL` projection, `corpus` as the `HASH` attribute, and `modality`/`page` as inline filters. This requires no additional Lambda or custom resource. Treat its schema as immutable and use a new index or lab for schema changes.

The CLI validates the deployed DynamoDB index, waits for `ACTIVE` without backfill, then for a successful call to the dedicated search endpoint. It does not create indexes through `UpdateTable`. Writes are ordinary DynamoDB list-of-number attributes; `SearchVectors` expects a plain list of numeric AttributeValues. The current SDK handles endpoint selection. Filters use equality, the common supported subset, even where newer SDK descriptions mention broader filters.

CDK/CloudFormation also creates the S3 Vectors bucket and index; `lab init` validates the deployed index's dimensions and distance metric. S3 Vectors stores source text as non-filterable metadata; small corpus/modality/page metadata remains filterable. Document content is available in every retrieval response without an extra content-table lookup, keeping baseline payloads comparable.

Image retrieval embeds **descriptions** of rendered PDF pages. The three vector engines see the same embedding space and cannot independently interpret images. Any image understanding comes from Bedrock. Direct RAG can pass the selected original JPEGs to the answer model. Use both caption retrieval quality and human assessment of the final visual answer; they measure different things.

## Sources

- [OpenSearch Serverless scale to zero](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-scale-to-zero.html): idle window and wake-up behavior.
- [NextGen vector collections](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-vector-search.html): IDs, mapping, compression, GPU build setting, refresh behavior.
- [Collection endpoints](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/serverless-collection-endpoints.html): NextGen per-collection and per-account endpoints.
- [Collection group limits](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/collection-groups-capacity-limits.html): OCU bounds.
- [CloudWatch monitoring](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/monitoring-cloudwatch.html): group-level metric dimensions.
- [DynamoDB vector launch](https://aws.amazon.com/blogs/aws/amazon-dynamodb-now-supports-real-time-vector-search-at-any-scale/): service overview.
- [Creating and searching vector indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/VectorSearchWorkingWith.html): schema, endpoints, readiness, synchronization.
- [DynamoDB SearchVectors API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_SearchVectors.html): request/response and score semantics.
- [DynamoDB CloudFormation table](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-dynamodb-table.html): current supported resource properties.
- [S3 metadata filtering](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-metadata-filtering.html): filterable and non-filterable metadata.
