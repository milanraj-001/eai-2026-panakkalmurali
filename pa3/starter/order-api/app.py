"""
Order API Service
=================
Receives orders via HTTP POST and publishes them to the orders.incoming queue.
Demonstrates the entry point for the EIP routing lab.
"""

import json
import uuid
import pika
import os
from flask import Flask, request, jsonify

app = Flask(__name__)


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


@app.route('/orders', methods=['POST'])
def create_order():
    """
    Accept an order via POST request and publish it to the orders.incoming queue.
    
    Expected JSON body:
    {
        "customerId": "cust-123",
        "items": [
            {"type": "physical", "name": "Laptop", "price": 999.99},
            {"type": "digital", "name": "Software License", "price": 49.99}
        ]
    }
    
    Returns:
        JSON with orderId and status, HTTP 202 Accepted
    """
    order = request.json
    
    # Assign unique identifiers
    order['orderId'] = str(uuid.uuid4())
    order['correlationId'] = order['orderId']
    
    # Publish to RabbitMQ
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    
    # Declare the queue (idempotent)
    channel.queue_declare(queue='orders.incoming', durable=True)
    
    # Publish the order message
    channel.basic_publish(
        exchange='',
        routing_key='orders.incoming',
        body=json.dumps(order),
        properties=pika.BasicProperties(delivery_mode=2)  # Persistent
    )
    
    connection.close()
    
    print(f"[Order API] Order {order['orderId']} received and published")
    
    return jsonify({'orderId': order['orderId'], 'status': 'received'}), 202


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint for container orchestration."""
    return jsonify({'status': 'healthy'}), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
