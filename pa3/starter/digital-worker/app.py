"""
Digital Worker
==============
Processes digital items from the orders.digital queue.
Simulates digital delivery (e.g., generating download links, license keys).
Publishes results to orders.results for aggregation.

Consumes from: orders.digital
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


def process_digital_item(ch, method, properties, body):
    """
    Process a digital item:
    1. Simulate digital delivery preparation
    2. Generate a download URL
    3. Publish result to orders.results
    """
    item_msg = json.loads(body)
    order_id = item_msg['orderId']
    item_index = item_msg['itemIndex']
    item = item_msg['item']
    
    print(f"[Digital] Processing digital item {item_index} for order {order_id}: {item.get('name', 'Unknown')}")
    
    # Simulate processing time (digital is faster than physical)
    processing_time = random.uniform(0.1, 0.5)
    time.sleep(processing_time)
    
    # Create result message
    result = {
        'orderId': order_id,
        'correlationId': item_msg['correlationId'],
        'itemIndex': item_index,
        'totalItems': item_msg['totalItems'],
        'status': 'delivered',
        'downloadUrl': f"https://downloads.example.com/{random.randint(10000, 99999)}",
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
    
    print(f"[Digital] Completed item {item_index} for order {order_id} - URL: {result['downloadUrl']}")
    
    # Acknowledge the message
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    """Main entry point: connect to RabbitMQ and start consuming digital items."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    
    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.digital', durable=True)
    
    # Fair dispatch
    channel.basic_qos(prefetch_count=1)
    
    # Start consuming
    channel.basic_consume(queue='orders.digital', on_message_callback=process_digital_item)
    
    print('[Digital Worker] Waiting for digital items...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
