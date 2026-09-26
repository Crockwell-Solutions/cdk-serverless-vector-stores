/**
 * Lambda handler — GET /health
 *
 * Healthcheck endpoint that verifies DynamoDB connectivity by querying
 * the main table with a limit of 50 items. Returns the DB latency
 * in the response. This endpoint does not require authentication.
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { RETURN_HEADERS } from '../shared';

const REGION = process.env.REGION!;
const TABLE_NAME = process.env.TABLE_NAME!;

const client = new DynamoDBClient({ region: REGION });

export const handler = async (): Promise<APIGatewayProxyResult> => {
  const start = Date.now();
  let dbStatus: 'healthy' | 'unhealthy' = 'healthy';
  let itemCount = 0;
  let errorMessage: string | undefined;

  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': { S: 'TEST' },
        ':skPrefix': { S: 'TEST' },
      },
      Limit: 50,
    });

    const result = await client.send(command);
    itemCount = result.Count ?? 0;
  } catch (error) {
    dbStatus = 'unhealthy';
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
  }

  const dbLatencyMs = Date.now() - start;

  const statusCode = dbStatus === 'healthy' ? 200 : 503;

  return {
    ...RETURN_HEADERS,
    statusCode,
    body: JSON.stringify({
      status: dbStatus,
      timestamp: new Date().toISOString(),
      region: REGION,
      database: {
        status: dbStatus,
        tableName: TABLE_NAME,
        latencyMs: dbLatencyMs,
        itemCount,
        ...(errorMessage && { error: errorMessage }),
      },
    }),
  };
};
