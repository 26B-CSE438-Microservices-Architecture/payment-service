const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const prisma = require('../lib/prisma');
const config = require('../config');
const { generatePaymentId } = require('../utils/id');

const brokers = (process.env.KAFKA_BROKERS || process.env.SPRING_KAFKA_BOOTSTRAP_SERVERS || 'kafka:9092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

const kafka = new Kafka({
  clientId: 'payment-service-worker',
  brokers,
});

const consumer = kafka.consumer({ groupId: 'payment-service' });
const producer = kafka.producer();

const ORDER_TOPICS = [
  'order.payment.hold.requested',
  'order.payment.capture.requested',
  'order.payment.hold.release.requested',
  'order.refund.requested',
];

function parseMessage(message) {
  if (!message.value) return null;

  const raw = message.value.toString();
  const parsed = JSON.parse(raw);

  // Spring's JsonSerializer may serialize a String payload as a JSON string.
  return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
}

function payloadAmountToMinorUnits(totalAmount) {
  const amount = Number(totalAmount?.amount ?? totalAmount ?? 0);
  return Math.round(amount * 100);
}

function eventTypeFor(topic) {
  return topic.replaceAll('.', '_').toUpperCase();
}

async function publishPaymentEvent(topic, correlationId, payload) {
  const event = {
    eventId: randomUUID(),
    eventType: eventTypeFor(topic),
    correlationId: correlationId || payload.orderId,
    occurredAt: new Date().toISOString(),
    payload,
  };

  await producer.send({
    topic,
    messages: [{
      key: payload.orderId,
      value: JSON.stringify(event),
      headers: { __TypeId__: Buffer.from('java.util.HashMap') },
    }],
  });

  console.log(`Published ${topic} for orderId=${payload.orderId}`);
}

async function logPaymentEvent(paymentId, fromStatus, toStatus, details) {
  await prisma.paymentEvent.create({
    data: {
      paymentId,
      fromStatus,
      toStatus,
      triggeredBy: 'payment-worker',
      details: details || undefined,
    },
  });
}

async function handleHoldRequested(event) {
  const payload = event.payload || {};
  const orderId = String(payload.orderId);
  const userId = String(payload.userId);
  const amount = payloadAmountToMinorUnits(payload.totalAmount);
  const currency = payload.totalAmount?.currency || 'TRY';
  const idempotencyKey = `order-hold-${orderId}`;

  let payment = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (!payment) {
    payment = await prisma.payment.create({
      data: {
        id: generatePaymentId(),
        idempotencyKey,
        orderId,
        userId,
        amount,
        currency,
        method: payload.paymentMethod || 'card',
        status: 'AUTHORIZED',
        provider: config.paymentProvider || 'event-worker',
        providerTxId: `event_hold_${orderId}`,
        authorizedAt: new Date(),
        metadata: { sourceEventId: event.eventId, restaurantId: payload.restaurantId },
      },
    });
    await logPaymentEvent(payment.id, 'CREATED', 'AUTHORIZED', { source: 'order.payment.hold.requested' });
  }

  if (payment.status === 'AUTHORIZED' || payment.status === 'CAPTURED') {
    await publishPaymentEvent('payment.hold_confirmed', event.correlationId, {
      orderId,
      paymentId: payment.id,
      userId,
      amount: payment.amount,
      currency: payment.currency,
      status: 'AUTHORIZED',
    });
    return;
  }

  await publishPaymentEvent('payment.hold_failed', event.correlationId, {
    orderId,
    paymentId: payment.id,
    userId,
    failureReason: `payment_in_${payment.status.toLowerCase()}_state`,
  });
}

async function findPaymentForEvent(payload) {
  if (payload.paymentId) {
    const byId = await prisma.payment.findUnique({ where: { id: String(payload.paymentId) } });
    if (byId) return byId;
  }

  return prisma.payment.findFirst({
    where: { orderId: String(payload.orderId) },
    orderBy: { createdAt: 'desc' },
  });
}

async function handleCaptureRequested(event) {
  const payload = event.payload || {};
  const orderId = String(payload.orderId);
  const payment = await findPaymentForEvent(payload);

  if (!payment) {
    await publishPaymentEvent('payment.capture_failed', event.correlationId, {
      orderId,
      paymentId: payload.paymentId || '',
      failureReason: 'payment_not_found',
    });
    return;
  }

  if (payment.status === 'CAPTURED') {
    await publishPaymentEvent('payment.capture_completed', event.correlationId, {
      orderId,
      paymentId: payment.id,
      userId: payment.userId,
      amount: payment.amount,
      currency: payment.currency,
      status: 'CAPTURED',
    });
    return;
  }

  if (payment.status !== 'AUTHORIZED') {
    await publishPaymentEvent('payment.capture_failed', event.correlationId, {
      orderId,
      paymentId: payment.id,
      failureReason: `payment_in_${payment.status.toLowerCase()}_state`,
    });
    return;
  }

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'CAPTURED', capturedAt: new Date() },
  });
  await logPaymentEvent(payment.id, 'AUTHORIZED', 'CAPTURED', { source: 'order.payment.capture.requested' });

  await publishPaymentEvent('payment.capture_completed', event.correlationId, {
    orderId,
    paymentId: updated.id,
    userId: updated.userId,
    amount: updated.amount,
    currency: updated.currency,
    status: 'CAPTURED',
  });
}

async function handleHoldReleaseRequested(event) {
  const payload = event.payload || {};
  const orderId = String(payload.orderId);
  const payment = await findPaymentForEvent(payload);

  if (!payment) {
    await publishPaymentEvent('payment.hold_released', event.correlationId, {
      orderId,
      paymentId: payload.paymentId || '',
      userId: payload.userId,
      status: 'VOIDED',
    });
    return;
  }

  if (payment.status === 'AUTHORIZED') {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'VOIDED',
        cancelledAt: new Date(),
        cancelReason: payload.reason || 'hold_release_requested',
      },
    });
    await logPaymentEvent(payment.id, 'AUTHORIZED', 'VOIDED', { reason: payload.reason });
  }

  await publishPaymentEvent('payment.hold_released', event.correlationId, {
    orderId,
    paymentId: payment.id,
    userId: payment.userId,
    status: 'VOIDED',
  });
}

async function handleRefundRequested(event) {
  const payload = event.payload || {};
  const orderId = String(payload.orderId);
  const payment = await findPaymentForEvent(payload);

  if (!payment) return;

  if (payment.status === 'CAPTURED') {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        cancelledAt: new Date(),
        cancelReason: 'refund_requested',
      },
    });
    await logPaymentEvent(payment.id, 'CAPTURED', 'REFUNDED', { source: 'order.refund.requested' });
  }

  await publishPaymentEvent('payment.refunded', event.correlationId, {
    orderId,
    paymentId: payment.id,
    userId: payment.userId,
    status: 'REFUNDED',
  });
}

async function handleEvent(topic, event) {
  switch (topic) {
    case 'order.payment.hold.requested':
      return handleHoldRequested(event);
    case 'order.payment.capture.requested':
      return handleCaptureRequested(event);
    case 'order.payment.hold.release.requested':
      return handleHoldReleaseRequested(event);
    case 'order.refund.requested':
      return handleRefundRequested(event);
    default:
      return undefined;
  }
}

async function start() {
  console.log(`Payment worker connecting to Kafka brokers: ${brokers.join(', ')}`);
  await producer.connect();
  await consumer.connect();

  for (const topic of ORDER_TOPICS) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const event = parseMessage(message);
        if (!event) return;

        console.log(`Received ${topic} for orderId=${event.payload?.orderId || 'unknown'}`);
        await handleEvent(topic, event);
      } catch (err) {
        console.error(`Failed to process ${topic}:`, err);
        throw err;
      }
    },
  });
}

async function shutdown() {
  console.log('Payment worker shutting down...');
  await consumer.disconnect();
  await producer.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(async (err) => {
  console.error('Payment worker failed:', err);
  await shutdown();
});
