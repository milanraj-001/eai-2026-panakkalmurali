/**
 * Thin wrapper over the RabbitMQ HTTP management API
 * (https://www.rabbitmq.com/docs/management#http-api). Used where a test
 * needs to observe a queue without competing with the worker that is
 * meant to consume it.
 */

import {
  RABBITMQ_MGMT_URL,
  RABBITMQ_MGMT_USER,
  RABBITMQ_MGMT_PASS,
} from "./env.js";

const authHeader =
  "Basic " +
  Buffer.from(`${RABBITMQ_MGMT_USER}:${RABBITMQ_MGMT_PASS}`).toString(
    "base64",
  );

async function mgmtFetch(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${RABBITMQ_MGMT_URL}${pathname}`, {
    ...init,
    headers: { Authorization: authHeader, ...(init?.headers ?? {}) },
  });
}

export interface QueueInfo {
  name: string;
  messages: number;
  messages_ready: number;
  messages_unacknowledged: number;
}

/** Current depth of a queue, as RabbitMQ itself reports it. */
export async function queueInfo(queueName: string): Promise<QueueInfo> {
  const res = await mgmtFetch(`/api/queues/%2f/${encodeURIComponent(queueName)}`);
  if (!res.ok) {
    throw new Error(
      `management API GET /queues/${queueName} -> ${res.status}`,
    );
  }
  return (await res.json()) as QueueInfo;
}

export interface PeekedMessage<T = unknown> {
  payload: T;
  redelivered: boolean;
}

/**
 * Peek at up to `count` messages sitting in a queue WITHOUT consuming
 * them -- requeue=true puts every message straight back. Useful for
 * asserting what the router published while its real consumers are
 * paused, without racing them for the message.
 */
export async function peekQueue<T = unknown>(
  queueName: string,
  count = 50,
): Promise<PeekedMessage<T>[]> {
  const res = await mgmtFetch(
    `/api/queues/%2f/${encodeURIComponent(queueName)}/get`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        count,
        ackmode: "ack_requeue_true",
        encoding: "auto",
        truncate: 50_000,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`management API POST /queues/${queueName}/get -> ${res.status}`);
  }
  const raw = (await res.json()) as Array<{
    payload: string;
    redelivered: boolean;
  }>;
  return raw.map((m) => ({
    payload: JSON.parse(m.payload) as T,
    redelivered: m.redelivered,
  }));
}
