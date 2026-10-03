"""
Aggregator Service
==================
Your job: implement the AGGREGATOR pattern on top of the connection
handling and consume loop already wired up below.

- Collect item results from orders.results, grouped by orderId.
- Completion condition: every item of the order has reported a result.
- Timeout: if the order has been sitting incomplete for too long (one
  worker crashed, or was never running), emit a PARTIAL result instead of
  waiting forever. A hung order is a worse outcome than an honest partial
  answer.
- Duplicate results (the same item redelivered, e.g. after a requeue) must
  not be double-counted.
- Two orders in flight at once must never have their results mixed up.

Consumes from: orders.results
Publishes to:  orders.complete

Required shape of the message you publish to orders.complete (tests depend
on every one of these fields):

    {
        "orderId": "<the order this result set belongs to>",
        "correlationId": "<same value as orderId>",
        "status": "complete" | "partial",
        "totalItems": <the totalItems every item message carried>,
        "receivedItems": <how many distinct items you actually collected>,
        "itemResults": [ <the result messages you received, in any order> ],
        "missingItemIndexes": [ <itemIndex values you never received>
                                 -- empty list when status == "complete" ]
    }

Publish exactly ONE message to orders.complete per order, whichever status
it ends up with.
"""

import json
import pika
import os
import threading
import time


# order_id -> {
#   'correlation_id': str,
#   'total_items': int,
#   'items': { itemIndex: result_dict },   # keyed so duplicates overwrite, not duplicate
#   'last_activity': float (time.time()),
# }
in_flight = {}
lock = threading.Lock()

# TODO: how long should an order sit with no new results before you give up
# and emit a partial? Too short and normal processing latency trips it;
# too long and "partial" stops meaning anything. Write down the number you
# pick and why in docs/adr-002.md -- this is one of its required decisions.
IDLE_TIMEOUT_SECONDS = float(os.environ.get('AGGREGATOR_IDLE_TIMEOUT_SECONDS', '5'))

# How often the background sweep checks for timed-out orders. Independent
# of IDLE_TIMEOUT_SECONDS; this just controls how promptly a timeout is
# noticed once it has actually elapsed.
SWEEP_INTERVAL_SECONDS = 1.0


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


def publish_completion(message):
    """Publish a single message to orders.complete. Called with the lock
    already released -- do not hold `lock` while doing network I/O."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    channel.queue_declare(queue='orders.complete', durable=True)
    channel.basic_publish(
        exchange='',
        routing_key='orders.complete',
        body=json.dumps(message),
        properties=pika.BasicProperties(delivery_mode=2)  # Persistent
    )
    connection.close()


def aggregate_result(ch, method, properties, body):
    try:
        result = json.loads(body)
        order_id = result['orderId']
        correlation_id = result.get('correlationId', order_id)
        item_index = result['itemIndex']
        total_items = result['totalItems']
    except (json.JSONDecodeError, KeyError) as exc:
        print(f"[Aggregator] Dropping unparseable result: {exc}")
        ch.basic_ack(delivery_tag=method.delivery_tag)
        return

    completion_message = None

    with lock:
        entry = in_flight.get(order_id)
        if entry is None:
            entry = {
                'correlation_id': correlation_id,
                'total_items': total_items,
                'items': {},
                'last_activity': time.time(),
            }
            in_flight[order_id] = entry

        entry['last_activity'] = time.time()
        entry['items'][item_index] = result  # overwrite: a duplicate is a no-op, not a second entry

        if len(entry['items']) >= entry['total_items']:
            completion_message = {
                "orderId": order_id,
                "correlationId": entry['correlation_id'],
                "status": "complete",
                "totalItems": entry['total_items'],
                "receivedItems": len(entry['items']),
                "itemResults": list(entry['items'].values()),
                "missingItemIndexes": [],
            }
            del in_flight[order_id]

    if completion_message is not None:
        publish_completion(completion_message)

    ch.basic_ack(delivery_tag=method.delivery_tag)


def sweep_timeouts():
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        now = time.time()
        timed_out_messages = []

        with lock:
            for order_id, entry in list(in_flight.items()):
                if now - entry['last_activity'] > IDLE_TIMEOUT_SECONDS:
                    received_indexes = set(entry['items'].keys())
                    missing = [
                        i for i in range(entry['total_items'])
                        if i not in received_indexes
                    ]
                    timed_out_messages.append({
                        "orderId": order_id,
                        "correlationId": entry['correlation_id'],
                        "status": "partial",
                        "totalItems": entry['total_items'],
                        "receivedItems": len(entry['items']),
                        "itemResults": list(entry['items'].values()),
                        "missingItemIndexes": missing,
                    })
                    del in_flight[order_id]

        for message in timed_out_messages:
            publish_completion(message)


def main():
    """Main entry point: connect to RabbitMQ, start the timeout sweeper,
    and start consuming results."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare queues (idempotent)
    channel.queue_declare(queue='orders.results', durable=True)
    channel.queue_declare(queue='orders.complete', durable=True)

    # Fair dispatch
    channel.basic_qos(prefetch_count=1)

    # Background thread: sweeps for orders that timed out waiting on a
    # worker that never answered.
    sweeper = threading.Thread(target=sweep_timeouts, daemon=True)
    sweeper.start()

    # Start consuming
    channel.basic_consume(queue='orders.results', on_message_callback=aggregate_result)

    print('[Aggregator] Waiting for results...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
