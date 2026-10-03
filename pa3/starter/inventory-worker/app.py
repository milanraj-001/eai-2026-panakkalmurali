"""
Inventory Worker
================
Processes physical items from the orders.physical queue.
Simulates inventory check and shipping preparation.
Publishes results to orders.results for aggregation.

Consumes from: orders.physical
Publishes to: orders.results
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


def process_physical_item(ch, method, properties, body):
    """
    Process a physical item:
    1. Simulate inventory check and shipping preparation
    2. Generate a tracking number
    3. Publish result to orders.results
    """
    item_msg = json.loads(body)
    order_id = item_msg['orderId']
    item_index = item_msg['itemIndex']
    item = item_msg['item']
    
    print(f"[Inventory] Processing physical item {item_index} for order {order_id}: {item.get('name', 'Unknown')}")
    
    # Simulate processing time (inventory check, packaging, etc.)
    processing_time = random.uniform(0.5, 2.0)
    time.sleep(processing_time)
    
    # Create result message
    result = {
        'orderId': order_id,
        'correlationId': item_msg['correlationId'],
        'itemIndex': item_index,
        'totalItems': item_msg['totalItems'],
        'status': 'shipped',
        'trackingNumber': f"TRK-{random.randint(10000, 99999)}",
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
    
    print(f"[Inventory] Completed item {item_index} for order {order_id} - Tracking: {result['trackingNumber']}")
    
    # Acknowledge the message
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    """Main entry point: connect to RabbitMQ and start consuming physical items."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    
    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.physical', durable=True)
    
    # Fair dispatch
    channel.basic_qos(prefetch_count=1)
    
    # Start consuming
    channel.basic_consume(queue='orders.physical', on_message_callback=process_physical_item)
    
    print('[Inventory Worker] Waiting for physical items...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
