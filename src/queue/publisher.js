const amqp = require('amqplib');
const config = require('../config');

const EXCHANGE = 'payment.events';
const EXCHANGE_TYPE = 'topic';

let connection = null;
let channel = null;
let connected = false;

async function connect() {
  try {
    connection = await amqp.connect(config.rabbitmqUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE, EXCHANGE_TYPE, { durable: true });
    connected = true;
    console.log('RabbitMQ publisher connected');

    connection.on('error', (err) => {
      console.error('RabbitMQ connection error:', err.message);
      connected = false;
    });

    connection.on('close', () => {
      console.warn('RabbitMQ connection closed, reconnecting in 5s...');
      connected = false;
      setTimeout(connect, 5000);
    });
  } catch (err) {
    console.error('RabbitMQ connect failed:', err.message);
    connected = false;
    setTimeout(connect, 5000);
  }
}

function publish(routingKey, payload) {
  if (!channel) {
    console.warn('RabbitMQ channel not ready, dropping event:', routingKey);
    return false;
  }
  const message = Buffer.from(JSON.stringify(payload));
  channel.publish(EXCHANGE, routingKey, message, { persistent: true });
  console.log(`Published ${routingKey}:`, payload.paymentId || '');
  return true;
}

function isConnected() {
  return connected;
}

async function close() {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
  } catch (err) {
    // ignore close errors
  }
  connected = false;
}

module.exports = { connect, publish, isConnected, close };
