const { getDb } = require('./src/database/db');

async function testDb() {
  try {
    const db = await getDb();
    console.log("DB connected successfully");
    process.exit(0);
  } catch (err) {
    console.error("DB connection error:", err);
    process.exit(1);
  }
}
testDb();
