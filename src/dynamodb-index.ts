import type { TableDescription, VectorIndexDescription } from '@aws-sdk/client-dynamodb';

// Each search is scoped to one corpus; modality and page filter records within that corpus.
const searchFields = [
  { name: 'corpus', schemaType: 'HASH', attributeType: 'S' },
  { name: 'modality', schemaType: 'INLINE_FILTER', attributeType: 'S' },
  { name: 'page', schemaType: 'INLINE_FILTER', attributeType: 'N' },
] as const;

/**
 * Describe the vector index schema used to validate the CDK deployment and runtime configuration.
 */
export function dynamoVectorIndexDefinition(indexName: string, dimensions: number) {
  return {
    IndexName: indexName,
    Dimensions: dimensions,
    DistanceFunction: 'COSINE' as const,
    VectorAttribute: { AttributeName: 'vector' },
    Projection: { ProjectionType: 'ALL' as const },
    SearchSchema: searchFields.map((field) => ({
      AttributeName: field.name,
      SearchSchemaElementType: field.schemaType,
    })),
  };
}

/**
 * Require the deployed index to match the lab's vector space, projection, and typed search fields.
 * Return the validated description so callers can check index readiness.
 */
export function assertDynamoIndex(
  table: TableDescription | undefined,
  indexName: string,
  dimensions: number,
): VectorIndexDescription {
  const index = table?.VectorIndexes?.find((candidate) => candidate.IndexName === indexName);

  if (!index) {
    throw new Error(`DynamoDB vector index ${indexName} is missing; run npm run deploy first.`);
  }

  const definition = dynamoVectorIndexDefinition(indexName, dimensions);
  const validFields =
    index.SearchSchema?.length === searchFields.length &&
    searchFields.every(
      (field) =>
        index.SearchSchema?.some(
          (entry) => entry.AttributeName === field.name && entry.SearchSchemaElementType === field.schemaType,
        ) &&
        table?.AttributeDefinitions?.some(
          (entry) => entry.AttributeName === field.name && entry.AttributeType === field.attributeType,
        ),
    );

  if (
    index.Dimensions !== definition.Dimensions ||
    index.DistanceFunction !== definition.DistanceFunction ||
    index.VectorAttribute?.AttributeName !== definition.VectorAttribute.AttributeName ||
    index.Projection?.ProjectionType !== definition.Projection.ProjectionType ||
    !validFields
  ) {
    throw new Error('DynamoDB index schema mismatch. Check the deployed stack and run npm run deploy.');
  }

  return index;
}
