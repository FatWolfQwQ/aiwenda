const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

if (fs.existsSync(ENV_PATH)) {
  const lines = fs.readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
const KNOWLEDGE_BASES_DIR = path.join(ROOT, 'data', 'knowledge-bases');
const LOGS_DIR = path.join(ROOT, 'data', 'logs');
const OCR_SCRIPT_PATH = path.join(ROOT, 'scripts', 'ocr-document.ps1');

module.exports = {
  PORT,
  ROOT,
  PUBLIC_DIR,
  DB_PATH,
  UPLOAD_DIR,
  KNOWLEDGE_BASES_DIR,
  LOGS_DIR,
  OCR_SCRIPT_PATH
};
