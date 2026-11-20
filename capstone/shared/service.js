import http from "node:http";
import amqp from "amqplib";

const serviceName = process.env.SERVICE_NAME;
const queueName = process.env.CONSUMER_QUEUE || "";
const port = Number(process.env.PORT || 8800);
const rabbitUrl = process.env.RABBITMQ_URL;

let brokerStatus = "down";
const consumers = {};

async function connectToRabbit() {
  let attempt = 0;

  while (true) {
    try {
      console.log(`[${serviceName}] Connecting to RabbitMQ...`);

      const connection = await amqp.connect(rabbitUrl);
      const channel = await connection.createChannel();

      connection.on("error", (err) => {
        brokerStatus = "down";
        console.error(`[${serviceName}] RabbitMQ error:`, err.message);
      });

      connection.on("close", () => {
        brokerStatus = "down";
        console.error(`[${serviceName}] RabbitMQ connection closed`);
        process.exit(1);
      });

      if (queueName) {
        await channel.consume(queueName, (message) => {
          if (!message) return;

          console.log(`[${serviceName}] Received message from ${queueName}`);
          channel.ack(message);
        });

        consumers[queueName] = 1;
      }

      brokerStatus = "up";
      console.log(`[${serviceName}] RabbitMQ connected`);
      return;
    } catch (err) {
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10000);

      console.error(
        `[${serviceName}] RabbitMQ connection attempt ${attempt} failed: ${err.message}`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const healthy = brokerStatus === "up";

    res.writeHead(healthy ? 200 : 503, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      status: healthy ? "ok" : "unhealthy",
      checks: {
        broker: brokerStatus,
        consumers
      }
    }));

    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

async function start() {
  await connectToRabbit();

  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] Listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error(`[${serviceName}] Startup failed:`, err);
  process.exit(1);
});
