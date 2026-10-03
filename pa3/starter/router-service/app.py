"""
Router Service
==============
Your job: implement two EIP patterns on top of the connection handling and
consume loop already wired up below.

1. SPLITTER: Break a multi-item order into one message per line item.
2. CONTENT-BASED ROUTER: Route each item message to a queue chosen by
   item['type'] -- physical / digital / subscription.

Consumes from: orders.incoming
Publishes to:  orders.physical, orders.digital, orders.subscription

Required shape of each item message you publish (the aggregator and the
tests depend on every one of these fields being present):

    {
        "orderId": "<same orderId as the incoming order>",
        "correlationId": "<same value as orderId -- this is what lets the
                            aggregator group results from the same order>",
        "itemIndex": <0-based position of this item within order['items']>,
        "totalItems": <len(order['items'])>,
        "item": <the original item object, unchanged>
    }

Every item message for a given order MUST carry the same correlationId and
the same totalItems -- that is how correlation is preserved once the order
has been split into independent messages travelling independent paths.
"""

import json
import pika
import os


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


# Map an item's `type` field to the routing key (== queue name, since we
# publish to the default exchange) it should be sent to.
ROUTES = {
    'physical': 'orders.physical',
    'digital': 'orders.digital',
    'subscription': 'orders.subscription',
}

# For an item type we don't recognize: don't drop it silently. Route it
# somewhere visible instead, so it shows up in the management UI rather
# than vanishing — and since nothing consumes this queue, the aggregator's
# own idle timeout will eventually report it as a missing item in a
# partial completion, rather than hanging the whole order.
FALLBACK_QUEUE = 'orders.unrouted'


def route_order(ch, method, properties, body):
    order = json.loads(body)
    order_id = order['orderId']
    correlation_id = order['correlationId']

    print(f"[Router] Processing order {order_id}")

    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare every queue we might publish to (idempotent — safe every time).
    channel.queue_declare(queue='orders.physical', durable=True)
    channel.queue_declare(queue='orders.digital', durable=True)
    channel.queue_declare(queue='orders.subscription', durable=True)
    channel.queue_declare(queue=FALLBACK_QUEUE, durable=True)

    items = order.get('items', [])
    item_count = len(items)

    for index, item in enumerate(items):
        item_type = item.get('type')
        routing_key = ROUTES.get(item_type)

        if routing_key is None:
            print(
                f"[Router] Unknown item type '{item_type}' for order "
                f"{order_id}, item {index} — routing to {FALLBACK_QUEUE}"
            )
            routing_key = FALLBACK_QUEUE

        message = {
            "orderId": order_id,
            "correlationId": correlation_id,
            "itemIndex": index,
            "totalItems": item_count,
            "item": item,
        }

        channel.basic_publish(
            exchange='',
            routing_key=routing_key,
            body=json.dumps(message),
            properties=pika.BasicProperties(delivery_mode=2),
        )

    connection.close()

    ch.basic_ack(delivery_tag=method.delivery_tag)

    print(f"[Router] Order {order_id} split into {item_count} items and routed")

def main():
    """Main entry point: connect to RabbitMQ and start consuming orders."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.incoming', durable=True)

    # Fair dispatch: don't give more than one message to a worker at a time
    channel.basic_qos(prefetch_count=1)

    # Start consuming
    channel.basic_consume(queue='orders.incoming', on_message_callback=route_order)

    print('[Router] Waiting for orders...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
