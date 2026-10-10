# Reproducible experiments

## Baseline protocol

1. Prepare the complete bundled nine-page PDF. Preserve the corpus manifest: source hash, physical pages, chunk size, overlap, rendering size and schema version.
2. Embed once. Vision captions are a separately cached preprocessing operation. The resulting dataset has an identity derived from the preparation/model configuration. The exact float32 vectors are written to all selected backends.
3. Deploy with CDK, then run `init` and ingest. CDK creates the DynamoDB and S3 vector indexes; `init` creates or validates the OpenSearch mapping and checks the deployed indexes. Use `verify` after ingestion to avoid confusing refresh lag with retrieval accuracy. Increase its probe count for a larger run. Do not mutate the corpus while benchmarking.
4. Run the same question list, top-k, and filters. Queries are embedded before timing starts. SDK credentials are also resolved before the first search.
5. Keep first-request measurements separate from warmup and measured rounds. Rotate backend order per round; keep host/network location constant. Record concurrency.
6. Keep the JSON and CSV alongside package-lock.json and your code revision. Repeat independent runs at different times. Use significantly more than the smoke-test default before drawing conclusions about tail latency.

The corpus filter is mandatory for every backend. A page or modality filter is applied before nearest-neighbor retrieval, and also before the local exact baseline. A question whose labelled pages are outside the prepared corpus fails early, as does an image-only benchmark without image-description records.

## What the report measures

- **Client latency:** one complete retrieval call, including signing, SDK serialization/deserialization, network, and retries. It excludes question embedding, local baseline calculation, LLM generation, and writing the sample file. It is not server processing time.
- **p50/p95/p99:** nearest-rank percentiles of successful warm samples. With few samples p99 is usually the maximum; do not overinterpret it.
- **Failures:** every error has its duration and message in samples.jsonl. Failed calls are excluded from success latency/recall aggregates but explicitly counted; the process exits 1 if any phase failed. Always report error rate with latency.
- **Recall@k:** overlap with exact cosine neighbors in the **same** local dataset and filter, divided by min(k, eligible corpus size). Equal-scoring alternatives at the boundary count as correct within 1e-6. Duplicate returned IDs cannot inflate recall. Empty eligible populations return null, never a perfect score. This measures approximate-neighbor fidelity, not whether the answer is useful.
- **Page hit rate/MRR:** whether at least one manually labelled expected physical page appears in the results, and reciprocal rank of the first such chunk. No labels yields null. Labels are incomplete relevance judgments and may omit other valid pages. A query can achieve perfect vector recall and still miss its evidence page.
- **Warm batch throughput:** requests per second including local exact-search, scoring and report-writing overhead. It is a client workload measure, not the store's maximum capacity. Increasing concurrency also increases load, cost and throttling risk.
- **Ingestion:** per-batch acknowledged write time is printed by ingest. This includes retries and is not time-to-searchable. Checkpoints make repeated runs partial; use a fresh dataset or `--force` for a fresh write experiment. Model and image-upload time must be measured separately.

No automatic LLM judge scores are reported. Use `query --answer --images` and review citation support, missing evidence, table row alignment and image readability. Generation latency and token usage are recorded in the query output.

## First request after idle

`benchmark --idle-seconds 660` prepares question embeddings/credentials, waits without store calls, and then records each backend's first search separately. It runs warm rounds afterward. The CLI does not call init or verify between the wait and the search. Keep every other client quiet, including dashboards and health checks that access the collection.

Read `metrics` before/after and retain the OCU timeline. A 660-second pause is a candidate cold run, not proof that OpenSearch was at zero. Delayed/missing CloudWatch metrics are inconclusive. If embedding credentials refresh during a long wait, or network DNS/TLS sessions are cold, those effects also contribute to client latency. S3/DynamoDB have no corresponding user-controlled OpenSearch OCU sleep state; label their measurement “first request,” not a proven engine cold start.

## Useful experiment matrix

| Experiment               | Hold constant                        | Change                                              |
| ------------------------ | ------------------------------------ | --------------------------------------------------- |
| Backend baseline         | Corpus, questions, model, k, filters | Store                                               |
| Text vs visual retrieval | PDF pages, store, questions          | Text-only corpus vs corpus with vision descriptions |
| Metadata selectivity     | Question/model/store/k               | Modality or one-page filter                         |
| Load                     | Corpus/questions/store               | `--concurrency 1`, 4, 8; larger round count         |
| Corpus size              | Models, chunking, question design    | Another complete PDF with matching question labels  |
| OpenSearch idle penalty  | Question/corpus/client               | Verified zero-OCU state vs warm state               |

Use separate corpora/config outputs/report directories for experiments. For a corpus-size experiment, use `prepare --pdf path/to/document.pdf` and a question set labelled for that complete document. Keep the corpus identical across stores within each comparison. Entire-corpus exact search is CPU/memory intensive and intended as an offline baseline for moderate demo sizes.
