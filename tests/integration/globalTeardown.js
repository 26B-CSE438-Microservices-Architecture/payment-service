module.exports = async () => {
  if (global.__POSTGRES_CONTAINER__) {
    console.log('\n[Integration] Stopping PostgreSQL container...');
    await global.__POSTGRES_CONTAINER__.stop();
    console.log('[Integration] Container stopped and removed.');
  }
};
