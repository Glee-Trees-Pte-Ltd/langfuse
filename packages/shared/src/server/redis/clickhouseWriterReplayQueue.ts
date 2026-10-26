import { Queue } from "bullmq";
import { QueueName, TQueueJobTypes } from "../queues";
import { createBullMQQueueOptionsWithRedis } from "./redis";
import { logger } from "../logger";

export class ClickhouseWriterReplayQueue {
  private static instance: Queue<
    TQueueJobTypes[QueueName.ClickhouseWriterReplayQueue]
  > | null = null;

  public static getInstance(): Queue<
    TQueueJobTypes[QueueName.ClickhouseWriterReplayQueue]
  > | null {
    if (ClickhouseWriterReplayQueue.instance)
      return ClickhouseWriterReplayQueue.instance;

    const queueOptionsWithRedis = createBullMQQueueOptionsWithRedis(
      QueueName.ClickhouseWriterReplayQueue,
    );
    ClickhouseWriterReplayQueue.instance = queueOptionsWithRedis
      ? new Queue<TQueueJobTypes[QueueName.ClickhouseWriterReplayQueue]>(
          QueueName.ClickhouseWriterReplayQueue,
          {
            ...queueOptionsWithRedis,
            defaultJobOptions: {
              removeOnComplete: true,
              // Failed jobs keep the blob key so exhausted replays can be found and retried.
              removeOnFail: 100_000,
              // Spans roughly eight hours of ClickHouse unavailability.
              attempts: 10,
              backoff: {
                type: "exponential",
                delay: 30_000,
              },
            },
          },
        )
      : null;

    ClickhouseWriterReplayQueue.instance?.on("error", (err) => {
      logger.error("ClickhouseWriterReplayQueue error", err);
    });

    return ClickhouseWriterReplayQueue.instance;
  }
}
