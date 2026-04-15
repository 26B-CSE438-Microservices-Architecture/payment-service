const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PAYMENT_API = process.env.PAYMENT_API_URL || 'http://localhost:3000';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://payment:payment123@localhost:5672';
const SELF_URL = process.env.SIMULATOR_URL || 'http://localhost:3002';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// Generate a JWT like the Auth Service would for a logged-in user
function generateAuthToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '1h' });
}

function authHeaders(userId = 'sim_user_1') {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${generateAuthToken(userId)}`,
  };
}

// In-memory order tracking
const orders = new Map();

// SSE clients
const sseClients = [];

// --- Static pages ---

app.get(['/', '/checkout'], (req, res) => {
  res.sendFile(path.join(__dirname, 'checkout.html'));
});

app.get(['/dashboard', '/dashboard/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// --- SSE ---

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

function broadcast(event) {
  const data = JSON.stringify(event);
  sseClients.forEach((client) => client.write(`data: ${data}\n\n`));
}

// --- Order state ---

function createOrder(orderId, amount) {
  const order = {
    orderId,
    amount,
    status: 'PENDING_PAYMENT',
    paymentId: null,
    paymentStatus: null,
    attempts: [],
    createdAt: new Date().toISOString(),
  };
  orders.set(orderId, order);
  return order;
}

function updateOrderFromPayment(orderId, paymentData, httpStatus) {
  const order = orders.get(orderId);
  if (!order) return;

  order.paymentId = paymentData.payment.id;
  order.paymentStatus = paymentData.payment.status;
  order.attempts.push({
    paymentId: paymentData.payment.id,
    status: paymentData.payment.status,
    httpStatus,
    at: new Date().toISOString(),
  });

  if (paymentData.payment.status === 'AUTHORIZED') {
    order.status = 'AWAITING_RESTAURANT';
  } else if (paymentData.payment.status === 'AWAITING_FORM') {
    order.status = 'AWAITING_FORM';
  } else if (paymentData.payment.status === 'FAILED') {
    order.status = 'PAYMENT_FAILED';
  }
  broadcast({ type: 'order_update', order });
}

// --- API: Create Payment ---
// This is what the Order Service does when a customer wants to pay.
// It calls the Payment API on behalf of the customer.

app.post('/api/create-payment', async (req, res) => {
  const { amount, orderId: existingOrderId, idempotencyKey: existingKey } = req.body;

  const orderId = existingOrderId || `ord_${uuidv4()}`;
  const idempotencyKey = existingKey || `idem_${uuidv4()}`;
  const paymentAmount = amount || 5000;

  // The Order Service builds the full payment request.
  // No card data — the payment flows through iyzico's hosted Checkout Form.
  const payload = {
    orderId,
    amount: paymentAmount,
    currency: 'TRY',
    paymentMethod: 'card',
    buyer: {
      id: 'sim_user_1',
      name: 'Test',
      surname: 'User',
      email: 'test@example.com',
      identityNumber: '74300864791',
      gsmNumber: '+905350000000',
      registrationAddress: 'Test Address, Istanbul',
      ip: req.ip || '127.0.0.1',
      city: 'Istanbul',
      country: 'Turkey',
      zipCode: '34000',
    },
    items: [{
      id: 'ITEM_1',
      name: 'Order Payment',
      category1: 'Food',
      itemType: 'PHYSICAL',
      price: String(paymentAmount / 100),
    }],
    // Tell Payment API where to redirect after checkout form completion.
    // {paymentId} is a placeholder that PaymentService will replace.
    callbackUrl: `${SELF_URL}/checkout-form-return/{paymentId}`,
  };

  try {
    const response = await fetch(`${PAYMENT_API}/payments`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    const isDuplicate = response.status === 200;

    broadcast({
      type: 'api_call',
      method: 'POST /payments',
      request: { orderId, amount: paymentAmount, idempotencyKey },
      response: data,
      status: response.status,
      isDuplicate,
    });

    if (data.payment && !isDuplicate) {
      if (!orders.has(orderId)) {
        createOrder(orderId, paymentAmount);
      } else {
        const order = orders.get(orderId);
        order.status = 'PENDING_PAYMENT';
        broadcast({ type: 'order_update', order });
      }
      updateOrderFromPayment(orderId, data, response.status);
    }

    const responseOrderId = isDuplicate && data.payment ? data.payment.orderId : orderId;
    res.json({ ...data, orderId: responseOrderId, idempotencyKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Checkout Form Return ---
// After the customer completes the iyzico checkout form,
// iyzico POSTs back here with the token. We forward it to Payment API
// to finalize, and tell the customer's browser the result.

app.post('/checkout-form-return/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  const token = req.body.token || req.query.token;

  let result = { status: 'error', message: 'Unknown error' };

  try {
    const response = await fetch(`${PAYMENT_API}/payments/${paymentId}/checkout-form/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json();

    broadcast({
      type: 'api_call',
      method: `POST /payments/${paymentId}/checkout-form/callback`,
      response: data,
      status: response.status,
    });

    result = {
      status: data.payment?.status === 'AUTHORIZED' ? 'success' : 'failure',
      paymentId,
      paymentStatus: data.payment?.status,
      message: data.payment?.status === 'AUTHORIZED'
        ? 'Payment authorized successfully'
        : (data.payment?.failureReason || 'Payment verification failed'),
    };
  } catch (err) {
    result = { status: 'error', message: err.message };
  }

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#f0f4f8;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:32px;width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1)}
.icon{font-size:48px;margin-bottom:12px}
h2{margin-bottom:8px;font-size:20px}
p{color:#64748b;font-size:14px;margin-bottom:20px}
a{display:inline-block;padding:10px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}
a:hover{background:#1d4ed8}
</style></head><body>
<div class="card">
<div class="icon">${result.status === 'success' ? '&#10003;' : '&#10007;'}</div>
<h2>${result.status === 'success' ? 'Payment Authorized' : 'Payment Failed'}</h2>
<p>${result.message}</p>
<a href="/">Back to Checkout</a>
</div>
<script>
if (window.parent !== window) {
  window.parent.postMessage(${JSON.stringify(result)}, '*');
}
</script>
</body></html>`);
});

// Also handle GET in case iyzico redirects instead of POST
app.get('/checkout-form-return/:paymentId', (req, res) => {
  const { paymentId } = req.params;
  const token = req.query.token;
  res.send(`<!DOCTYPE html><html><body>
<form id="f" method="POST" action="/checkout-form-return/${paymentId}">
<input type="hidden" name="token" value="${token || ''}">
</form><script>document.getElementById('f').submit();</script></body></html>`);
});

// --- API: Capture ---

app.post('/api/capture/:paymentId', async (req, res) => {
  try {
    const response = await fetch(`${PAYMENT_API}/payments/${req.params.paymentId}/capture`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount: req.body.amount }),
    });
    const data = await response.json();
    broadcast({
      type: 'api_call',
      method: `POST /payments/${req.params.paymentId}/capture`,
      response: data,
      status: response.status,
    });

    if (data.payment && data.payment.status === 'CAPTURED') {
      for (const order of orders.values()) {
        if (order.paymentId === req.params.paymentId) {
          order.status = 'CONFIRMED';
          order.paymentStatus = 'CAPTURED';
          broadcast({ type: 'order_update', order });
          break;
        }
      }
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Double Capture (concurrency test) ---

app.post('/api/double-capture/:paymentId', async (req, res) => {
  const captureReq = () =>
    fetch(`${PAYMENT_API}/payments/${req.params.paymentId}/capture`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount: req.body.amount }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  try {
    const [result1, result2] = await Promise.all([captureReq(), captureReq()]);
    broadcast({
      type: 'api_call',
      method: `DOUBLE CAPTURE /payments/${req.params.paymentId}/capture`,
      response: { request1: result1, request2: result2 },
      status: `${result1.status} / ${result2.status}`,
    });

    const succeeded = [result1, result2].find((r) => r.status === 200);
    if (succeeded) {
      for (const order of orders.values()) {
        if (order.paymentId === req.params.paymentId) {
          order.status = 'CONFIRMED';
          order.paymentStatus = 'CAPTURED';
          broadcast({ type: 'order_update', order });
          break;
        }
      }
    }
    res.json({ result1, result2 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Cancel / Void / Refund ---

app.post('/api/cancel/:paymentId', async (req, res) => {
  try {
    const response = await fetch(`${PAYMENT_API}/payments/${req.params.paymentId}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason: req.body.reason || 'Cancelled via simulator' }),
    });
    const data = await response.json();
    broadcast({
      type: 'api_call',
      method: `POST /payments/${req.params.paymentId}/cancel`,
      response: data,
      status: response.status,
    });

    if (data.payment) {
      for (const order of orders.values()) {
        if (order.paymentId === req.params.paymentId) {
          order.status = 'CANCELLED';
          order.paymentStatus = data.payment.status;
          broadcast({ type: 'order_update', order });
          break;
        }
      }
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Get payment / payments / orders ---

app.get('/api/payment/:paymentId', async (req, res) => {
  try {
    const response = await fetch(`${PAYMENT_API}/payments/${req.params.paymentId}`, {
      headers: { Authorization: `Bearer ${generateAuthToken('sim_user_1')}` },
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/payments', async (req, res) => {
  try {
    const response = await fetch(`${PAYMENT_API}/payments`, {
      headers: { Authorization: `Bearer ${generateAuthToken('sim_user_1')}` },
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders', (req, res) => {
  const orderList = Array.from(orders.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json({ orders: orderList });
});

// --- RabbitMQ subscriber ---

async function subscribeToEvents() {
  try {
    const connection = await amqp.connect(RABBITMQ_URL);
    const channel = await connection.createChannel();
    await channel.assertExchange('payment.events', 'topic', { durable: true });
    const { queue } = await channel.assertQueue('', { exclusive: true });
    await channel.bindQueue(queue, 'payment.events', 'payment.#');

    console.log('Simulator subscribed to payment events');

    channel.consume(queue, (msg) => {
      if (msg) {
        const routingKey = msg.fields.routingKey;
        const payload = JSON.parse(msg.content.toString());
        broadcast({ type: 'rabbitmq_event', routingKey, payload });

        const orderId = payload.orderId;
        const order = orders.get(orderId);
        if (order) {
          if (routingKey === 'payment.authorized' && order.status === 'AWAITING_FORM') {
            order.status = 'AWAITING_RESTAURANT';
            order.paymentId = payload.paymentId;
            order.paymentStatus = 'AUTHORIZED';
            const attempt = order.attempts.find(a => a.paymentId === payload.paymentId);
            if (attempt) attempt.status = 'AUTHORIZED';
            broadcast({ type: 'order_update', order });
          } else if (routingKey === 'payment.failed' && order.status === 'AWAITING_FORM') {
            order.status = 'PAYMENT_FAILED';
            order.paymentStatus = 'FAILED';
            const attempt = order.attempts.find(a => a.paymentId === payload.paymentId);
            if (attempt) attempt.status = 'FAILED';
            broadcast({ type: 'order_update', order });
          }
        }

        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error('Failed to subscribe to RabbitMQ:', err.message);
    setTimeout(subscribeToEvents, 5000);
  }
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Simulator running on port ${PORT}`);
  console.log(`  Checkout: http://localhost:${PORT}/`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard`);
  subscribeToEvents();
});
