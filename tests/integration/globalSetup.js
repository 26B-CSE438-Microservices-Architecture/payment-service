const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  console.log('\n[Integration] Starting PostgreSQL Container...');
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('testdb')
    .withUsername('testuser')
    .withPassword('testpass')
    .start();

  global.__POSTGRES_CONTAINER__ = container;

  const url = container.getConnectionUri();
  
  // Set DB URL globally for all tests in this process
  process.env.DATABASE_URL = `${url}?connection_limit=1`;
  console.log(`[Integration] DB Started. URL: ${process.env.DATABASE_URL}`);
  
  console.log('[Integration] Running Prisma generate...');
  execSync('npx prisma generate', {
    cwd: path.resolve(__dirname, '../../'),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'inherit'
  });

  console.log('[Integration] Running Prisma migrate deploy...');
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../'),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'inherit'
  });
  console.log('[Integration] Setup Finished.');
};
