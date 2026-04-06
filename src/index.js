const express = require('express');
const cors = require('cors');
const config = require('./config');
const prisma = require('./lib/prisma');
const publisher = require('./queue/publisher');
const { createProvider } = require('./providers');
const PaymentService = require('./core/PaymentService');
const CardService = require('./core/CardService');
const healthRoutes = require('./api/routes/health');
const { router: paymentRoutes, setup: setupPaymentRoutes } = require('./api/routes/payments');
const { router: cardRoutes, setup: setupCardRoutes } = require('./api/routes/cards');
const errorHandler = require('./api/middleware/errorHandler');

const app = express();

app.use(cors());
app.use(express.json());

// Initialize provider and services
const provider = createProvider();
const cardService = new CardService(provider);
const paymentService = new PaymentService(provider, cardService);
setupPaymentRoutes(paymentService);
setupCardRoutes(cardService);

// Routes
app.use('/health', healthRoutes);
app.use('/payments', paymentRoutes);
app.use('/cards', cardRoutes);

// Error handler (must be last)
app.use(errorHandler);

async function start() {
  // Connect to RabbitMQ
  await publisher.connect();

  app.listen(config.port, () => {
    console.log(`Payment API running on port ${config.port}`);
  });
}

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await publisher.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
