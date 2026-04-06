const amqp = require('amqplib');
const config = require('../config');

const EXCHANGE = 'payment.events';

async function start() {
  console.log('Worker starting...');

  const connection = await amqp.connect(config.rabbitmqUrl);
  const channel = await connection.createChannel();

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });

  // Create an exclusive queue for monitoring
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE, 'payment.#');

  console.log('Worker listening for payment events...');

  channel.consume(queue, (msg) => {
    if (msg) {
      const routingKey = msg.fields.routingKey;
      const payload = JSON.parse(msg.content.toString());
      console.log(`[${routingKey}]`, payload);
      channel.ack(msg);
    }
  });

  process.on('SIGTERM', async () => {
    console.log('Worker shutting down...');
    await channel.close();
    await connection.close();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
