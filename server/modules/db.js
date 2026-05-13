const fs = require('fs');
const { DB_PATH } = require('./paths');

let cachedDb = null;
let cachedMtimeMs = 0;

function normalizeDb(db) {
  db.knowledgeBases ||= [];
  db.documents ||= [];
  db.chunks ||= [];
  db.chatMessages ||= [];
  db.aiLogs ||= [];
  db.users ||= [];
  return db;
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(require('path').dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({
      knowledgeBases: [],
      documents: [],
      chunks: [],
      chatMessages: [],
      aiLogs: [],
      users: []
    }, null, 2), 'utf8');
  }
  const stat = fs.statSync(DB_PATH);
  if (cachedDb && cachedMtimeMs === stat.mtimeMs) return cachedDb;
  cachedDb = normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/^\uFEFF/, '')));
  cachedMtimeMs = stat.mtimeMs;
  return cachedDb;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  cachedDb = normalizeDb(db);
  cachedMtimeMs = fs.statSync(DB_PATH).mtimeMs;
}

module.exports = { readDb, writeDb };
