const express = require('express');
const cors = require('cors');
const config = require('./config');
const healthRoutes = require('./api/routes/health');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/health', healthRoutes);

app.listen(config.port, () => {
  console.log(`Payment API running on port ${config.port}`);
});
