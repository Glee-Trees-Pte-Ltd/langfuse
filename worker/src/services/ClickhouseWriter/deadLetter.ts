import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Job } from "bullmq";
import { z } from "zod";
import {
  buildClickHouseLogComment,
  clickhouseClient,
  ClickhouseWriterReplayEventSchema,
  ClickhouseWriterReplayQueue,
  createEventUploadStorageService,
  logger,
  QueueJobs,
  QueueName,
  recordIncrement,
  type StorageService,
  type TQueueJobTypes,
} from "@langfuse/shared/src/server";

import { env } from "../../env";
import { TableName } from "./types";

const DEAD_LETTER_METRIC = "langfuse.queue.clickhouse_writer.dead_letter";

export type DeadLetterReason = "max_attempts" | "shutdown";

const deadLetterBatchSchema = z.object({
  schemaVersion: z.literal(1),
  table: z.enum(TableName),
  reason: z.enum(["max_attempts", "shutdown"]),
  rows: z.array(z.record(z.string(), z.unknown())),
});

let storage: StorageService | undefined;

function getStorage(): StorageService {
  if (!storage)
    storage = createEventUploadStorageService(
      env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET,
    );
  return storage;
}

export function isDeadLetterTable(table: TableName): boolean {
  return env.LANGFUSE_CLICKHOUSE_WRITER_DEAD_LETTER_TABLES.includes(table);
}

/**
 * Stores rows the writer could not insert as one blob object and enqueues a replay job.
 * Never throws; returns false when the rows could not be staged and are lost.
 */
export async function stageDeadLetterRows(
  table: TableName,
  rows: object[],
  reason: DeadLetterReason,
): Promise<boolean> {
  if (rows.length === 0) return true;

  const id = randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  const key = `${env.LANGFUSE_S3_EVENT_UPLOAD_PREFIX}${env.LANGFUSE_CLICKHOUSE_WRITER_DEAD_LETTER_S3_PREFIX}${table}/${date}/${id}.json`;
  const tags = { entity_type: table, reason };

  try {
    await getStorage().uploadFile({
      fileName: key,
      fileType: "application/json",
      data: Readable.from([
        JSON.stringify({ schemaVersion: 1, table, reason, rows }),
      ]),
    });
  } catch (error) {
    recordIncrement(DEAD_LETTER_METRIC, rows.length, {
      ...tags,
      outcome: "stage_failed",
    });
    logger.error(
      `ClickhouseWriter: failed to stage ${rows.length} ${table} row(s) for replay`,
      { error, key },
    );
    return false;
  }

  try {
    const queue = ClickhouseWriterReplayQueue.getInstance();
    if (!queue) throw new Error("ClickhouseWriterReplayQueue is unavailable");
    await queue.add(
      QueueJobs.ClickhouseWriterReplayJob,
      {
        timestamp: new Date(),
        id,
        payload: { table, key, rowCount: rows.length },
        name: QueueJobs.ClickhouseWriterReplayJob,
      },
      { jobId: id },
    );
  } catch (error) {
    // The object stays in blob storage; the logged key is enough to replay it by hand.
    recordIncrement(DEAD_LETTER_METRIC, rows.length, {
      ...tags,
      outcome: "enqueue_failed",
    });
    logger.error(
      `ClickhouseWriter: staged ${rows.length} ${table} row(s) but could not enqueue replay`,
      { error, key },
    );
    return true;
  }

  recordIncrement(DEAD_LETTER_METRIC, rows.length, {
    ...tags,
    outcome: "staged",
  });
  logger.warn(
    `ClickhouseWriter: staged ${rows.length} ${table} row(s) for replay`,
    { key },
  );
  return true;
}

/** Inserts a staged batch directly so failures surface to BullMQ retries, then removes the object. */
export async function replayDeadLetterBatch(
  job: Job<TQueueJobTypes[QueueName.ClickhouseWriterReplayQueue]>,
): Promise<void> {
  const { key } = ClickhouseWriterReplayEventSchema.parse(job.data.payload);
  const batch = deadLetterBatchSchema.parse(
    JSON.parse(await getStorage().download(key)),
  );

  await clickhouseClient().insert({
    table: batch.table,
    format: "JSONEachRow",
    values: batch.rows,
    clickhouse_settings: {
      log_comment: buildClickHouseLogComment({
        surface: "worker",
        route: "clickhouse-writer-replay",
        projectId: "MULTI_PROJECT",
      }),
    },
  });
  await getStorage().deleteFiles([key]);

  recordIncrement(DEAD_LETTER_METRIC, batch.rows.length, {
    entity_type: batch.table,
    reason: batch.reason,
    outcome: "replayed",
  });
  logger.info(
    `ClickhouseWriter: replayed ${batch.rows.length} ${batch.table} row(s)`,
    { key, attempt: job.attemptsMade + 1 },
  );
}
