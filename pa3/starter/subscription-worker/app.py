"""
Subscription Worker
====================
Processes subscription items from the orders.subscription queue.
Simulates activating a recurring subscription (e.g. issuing a first
billing-cycle confirmation).
Publishes results to orders.results for aggregation.

Consumes from: orders.subscription
Publishes to: orders.results

This service is given to you working, the same way inventory-worker and
digital-worker are: it exists so that a "subscription" item actually
produces a result once your router routes it here. Your job is the router
and the aggregator, not this file.
"""

import json
import pika
import os
import time
import random


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


def process_subscription_item(ch, method, properties, body):
    """
    Process a subscription item:
    1. Simulate activating the subscription
    2. Generate a confirmation code
    3. Publish result to orders.results
    """
    item_msg = json.loads(body)
    order_id = item_msg['orderId']
    item_index = item_msg['itemIndex']
    item = item_msg['item']

    print(f"[Subscription] Processing subscription item {item_index} for order {order_id}: {item.get('name', 'Unknown')}")

    # Simulate processing time (activation is quick)
    processing_time = random.uniform(0.1, 0.5)
    time.sleep(processing_time)

    # Create result message
    result = {
        'orderId': order_id,
        'correlationId': item_msg['correlationId'],
        'itemIndex': item_index,
        'totalItems': item_msg['totalItems'],
        'status': 'activated',
        'confirmationCode': f"SUB-{random.randint(10000, 99999)}",
        'itemName': item.get('name', 'Unknown'),
        'processingTime': round(processing_time, 2)
    }

    # Publish result
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    channel.queue_declare(queue='orders.results', durable=True)

    channel.basic_publish(
        exchange='',
        routing_key='orders.results',
        body=json.dumps(result),
        properties=pika.BasicProperties(delivery_mode=2)  # Persistent
    )

    connection.close()

    print(f"[Subscription] Completed item {item_index} for order {order_id} - Confirmation: {result['confirmationCode']}")

    # Acknowledge the message
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    """Main entry point: connect to RabbitMQ and start consuming subscription items."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.subscription', durable=True)

    # Fair dispatch
    channel.basic_qos(prefetch_count=1)

    # Start consuming
    channel.basic_consume(queue='orders.subscription', on_message_callback=process_subscription_item)

    print('[Subscription Worker] Waiting for subscription items...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
