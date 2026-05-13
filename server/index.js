const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { execFile, spawn } = require('child_process');
const {
  PORT,
  ROOT,
  PUBLIC_DIR,
  UPLOAD_DIR,
  KNOWLEDGE_BASES_DIR,
  LOGS_DIR,
  OCR_SCRIPT_PATH
} = require('./modules/paths');
const { readDb, writeDb } = require('./modules/db');
const CHUNK_SEARCH_WORKER = path.join(__dirname, 'modules', 'chunk-search-worker.js');

const MAX_UPLOAD_BODY_SIZE = 80 * 1024 * 1024;
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.md', '.txt', '.log', '.csv', '.json', '.html', '.htm', '.xml',
  '.rtf', '.docx', '.pptx', '.xlsx', '.pdf',
  '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'
]);
const OCR_DOCUMENT_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff']);
const AI_CONFIG = {
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  chatModel: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-v4-flash'
};
const ADMIN_REGISTER_KEY = process.env.ADMIN_REGISTER_KEY || '';

for (const dir of [path.join(ROOT, 'data'), UPLOAD_DIR, KNOWLEDGE_BASES_DIR, LOGS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
const AVATAR_IDS = [
  'wolf', 'fox', 'cat', 'dog', 'bear', 'rabbit', 'panda', 'tiger', 'lion', 'deer',
  'raccoon', 'otter', 'hamster', 'koala', 'red-panda', 'squirrel', 'owl', 'penguin', 'seal', 'dragon'
];

// 后端当前按“配置/数据库模块 + 功能代码段”维护：
// - server/modules/paths.js：路径和脚本位置
// - server/modules/db.js：本地 JSON 数据库读写
// - 文档解析/OCR：本文件的 Document Processing 区域 + scripts/
// - 知识库/文档/AI问答/日志接口：handleApi 内按路由段分块
// 后续新增功能时优先新建 server/modules/*，不要继续扩大单个功能段。

// REGION: HTTP Utilities
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_UPLOAD_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}


// REGION: Native Windows Helpers
function selectFolder(title = '请选择文件夹') {
  return new Promise((resolve, reject) => {
    const tempFile = path.join(ROOT, 'data', `selected-folder-${Date.now()}.txt`);
    const safeTitle = String(title).replace(/'/g, "''");
    const safeTempFile = tempFile.replace(/'/g, "''");
    const script = `
      $shell = New-Object -ComObject Shell.Application
      $folder = $shell.BrowseForFolder(0, '${safeTitle}', 0, 17)
      if ($folder -ne $null) {
        [System.IO.File]::WriteAllText('${safeTempFile}', $folder.Self.Path, [System.Text.Encoding]::UTF8)
      }
    `;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: false },
      error => {
        if (error) return reject(error);
        if (!fs.existsSync(tempFile)) return resolve('');
        const folderPath = fs.readFileSync(tempFile, 'utf8').replace(/^\uFEFF/, '').trim();
        fs.unlinkSync(tempFile);
        resolve(folderPath);
      }
    );
  });
}
function openInExplorer(targetPath, selectFile = false) {
  return new Promise((resolve, reject) => {
    const args = selectFile ? [`/select,${targetPath}`] : [targetPath];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      setTimeout(resolve, 900);
      child.unref();
    });
  });
}

function runPowerShell(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 30 * 1024 * 1024,
      encoding: 'buffer'
    }, (error, stdout, stderr) => {
      const output = stdout ? Buffer.from(stdout).toString('utf8').replace(/^\uFEFF/, '') : '';
      const errorOutput = stderr ? Buffer.from(stderr).toString('utf8').replace(/^\uFEFF/, '').trim() : '';
      if (error) {
        reject(new Error(errorOutput || error.message));
        return;
      }
      resolve(output);
    });
  });
}

// REGION: Auth Helpers
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.passwordHash) return false;
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    avatarId: user.avatarId || 'wolf',
    brandAvatarId: user.brandAvatarId || 'wolf',
    busyAvatarId: user.busyAvatarId || 'wolf',
    aiAvatarId: user.aiAvatarId || 'wolf',
    createdAt: user.createdAt
  };
}

function normalizeAvatarId(value) {
  const id = String(value || 'wolf');
  return AVATAR_IDS.includes(id) ? id : 'wolf';
}

function requireAdminRegisterKey() {
  return ADMIN_REGISTER_KEY || crypto.randomBytes(24).toString('hex');
}


// REGION: File And Name Helpers
function removeDirIfEmpty(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath);
  }
}

function safeFileName(name) {
  return String(name || '未命名文档.txt').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function safeFolderName(name) {
  return String(name || '未命名知识库').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function isSupportedDocument(ext) {
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(String(ext || '').toLowerCase());
}

// REGION: Text Decoding And Cleanup
function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripInvalidControlChars(text) {
  return String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ');
}

function cleanDisplayText(text) {
  return stripInvalidControlChars(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/([\u3400-\u9fff])\s+([，。！？；：、“”‘’）》】])/g, '$1$2')
    .replace(/([（《【])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeExtractedText(text) {
  return stripInvalidControlChars(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/([\u3400-\u9fff])\s+([，。！？；：、“”‘’）》】])/g, '$1$2')
    .replace(/([（《【])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return normalizeExtractedText(buffer);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return normalizeExtractedText(buffer.slice(3).toString('utf8'));
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return normalizeExtractedText(buffer.slice(2).toString('utf16le'));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return normalizeExtractedText(decodeUtf16BE(buffer.slice(2)));
  }

  const candidates = [];
  try {
    candidates.push({ encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) });
  } catch {
    candidates.push({ encoding: 'utf-8', text: buffer.toString('utf8') });
  }
  for (const encoding of ['gb18030', 'big5', 'latin1']) {
    try {
      candidates.push({ encoding, text: new TextDecoder(encoding).decode(buffer) });
    } catch {
      if (encoding === 'latin1') candidates.push({ encoding, text: buffer.toString('latin1') });
    }
  }

  candidates.sort((a, b) => textQualityScore(b.text) - textQualityScore(a.text));
  return normalizeExtractedText(candidates[0]?.text || '');
}

function textQualityScore(text) {
  const value = String(text || '');
  if (!value) return 0;
  const len = value.length;
  const replacement = (value.match(/\uFFFD/g) || []).length;
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const normal = (value.match(/[a-zA-Z0-9\u3400-\u9fff，。！？；：、“”‘’（）《》【】,.!?;:'"()[\]{}\s\-_/\\]/g) || []).length;
  const mojibake = (value.match(/[ÃÂÄÅÆÇÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõøùúûüýþÿ]{2,}/g) || []).join('').length;
  const privateUse = (value.match(/[\uE000-\uF8FF]/g) || []).length;
  const c1Controls = (value.match(/[\u0080-\u009F]/g) || []).length;
  const visibleNoise = (value.match(/[^\w\u3400-\u9fff\s，。！？；：、“”‘’（）《》【】,.!?;:'"()[\]{}\-_/@#+%=*&|<>]/g) || []).length;
  return (normal / len) + Math.min(cjk / len, 0.35) - (replacement * 8 + mojibake * 2 + privateUse * 4 + c1Controls * 5 + visibleNoise * 1.5) / len;
}

function isLikelyGarbledText(text) {
  const value = normalizeExtractedText(text);
  if (value.length < 40) return false;
  const score = textQualityScore(value);
  const replacementRatio = ((value.match(/\uFFFD/g) || []).length / value.length);
  const privateRatio = ((value.match(/[\uE000-\uF8FF]/g) || []).length / value.length);
  const mojibakeRatio = ((value.match(/[ÃÂÄÅÆÇÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõøùúûüýþÿ]/g) || []).length / value.length);
  const c1Ratio = ((value.match(/[\u0080-\u009F]/g) || []).length / value.length);
  const shortLineRatio = value.split(/\n+/).filter(line => line.trim()).filter(line => line.trim().length <= 3).length / Math.max(1, value.split(/\n+/).filter(line => line.trim()).length);
  return score < 0.45 || replacementRatio > 0.01 || privateRatio > 0.03 || mojibakeRatio > 0.2 || c1Ratio > 0.01 || shortLineRatio > 0.45;
}

function stripHtmlText(text) {
  return decodeXmlEntities(String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

function stripRtfText(text) {
  return String(text || '')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, ' ');
}

// REGION: Office Document Extraction
function readZipEntries(buffer) {
  const entries = {};
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('压缩文档结构异常');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      if (method === 0) entries[name] = compressed;
      if (method === 8) entries[name] = zlib.inflateRawSync(compressed);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlText(xml) {
  return normalizeExtractedText(decodeXmlEntities(String(xml || '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>|<a:br\/>/g, '\n')
    .replace(/<\/w:p>|<\/a:p>|<\/row>/g, '\n')
    .replace(/<[^>]+>/g, ' ')));
}

function extractDocxText(buffer) {
  const entries = readZipEntries(buffer);
  const parts = Object.entries(entries)
    .filter(([name]) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name))
    .map(([, data]) => xmlText(data.toString('utf8')));
  return normalizeExtractedText(parts.join('\n'));
}

function extractPptxText(buffer) {
  const entries = readZipEntries(buffer);
  const parts = Object.entries(entries)
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true }))
    .map(([, data]) => xmlText(data.toString('utf8')));
  return normalizeExtractedText(parts.join('\n\n'));
}

function extractXlsxText(buffer) {
  const entries = readZipEntries(buffer);
  const sharedStrings = [];
  const sharedXml = entries['xl/sharedStrings.xml'];
  if (sharedXml) {
    const xml = sharedXml.toString('utf8');
    for (const match of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
      sharedStrings.push(xmlText(match[0]));
    }
  }

  const sheets = Object.entries(entries)
    .filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true }));

  const rows = [];
  for (const [, data] of sheets) {
    const xml = data.toString('utf8');
    for (const rowMatch of xml.matchAll(/<row[\s\S]*?<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>/g)) {
        const attrs = cellMatch[1];
        const value = decodeXmlEntities(cellMatch[2]);
        cells.push(/\bt="s"/.test(attrs) ? (sharedStrings[Number(value)] || '') : value);
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'));
    }
  }
  return normalizeExtractedText(rows.join('\n'));
}

// REGION: PDF And OCR Extraction
function decodePdfLiteral(value) {
  return String(value || '')
    .replace(/\\([nrtbf()\\])/g, (_, char) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[char] || char))
    .replace(/\\\d{1,3}/g, ' ');
}

function decodeUtf16BE(buffer) {
  const swapped = Buffer.alloc(buffer.length - (buffer.length % 2));
  for (let i = 0; i < swapped.length; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped.toString('utf16le');
}

function decodePdfHex(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) return '';
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16BE(bytes.slice(2));
  return bytes.toString('latin1');
}

function extractPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const parts = [];
  for (const match of raw.matchAll(/<<(.*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g)) {
    const dict = match[1];
    let stream = Buffer.from(match[2], 'latin1');
    if (/FlateDecode/.test(dict)) {
      try {
        stream = zlib.inflateSync(stream);
      } catch {
        continue;
      }
    }
    const content = stream.toString('latin1');
    for (const textMatch of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) parts.push(decodePdfLiteral(textMatch[1]));
    for (const arrayMatch of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      const text = [];
      for (const item of arrayMatch[1].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g)) {
        text.push(item[1] !== undefined ? decodePdfLiteral(item[1]) : decodePdfHex(item[2]));
      }
      parts.push(text.join(''));
    }
    for (const hexMatch of content.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) parts.push(decodePdfHex(hexMatch[1]));
  }
  return normalizeExtractedText(parts.join('\n'));
}

async function extractTextWithAiOcr(filePath, ext) {
  if (!OCR_DOCUMENT_EXTENSIONS.has(String(ext || '').toLowerCase())) return '';
  if (!fs.existsSync(OCR_SCRIPT_PATH)) throw new Error('OCR 脚本不存在');
  const text = await runPowerShell([
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    OCR_SCRIPT_PATH,
    '-Path',
    filePath,
    '-MaxPages',
    '80'
  ]);
  return normalizeExtractedText(text);
}

function extractTextFromDocument(buffer, ext) {
  const lowerExt = String(ext || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'].includes(lowerExt)) return '';
  if (['.md', '.txt', '.log', '.csv', '.json'].includes(lowerExt)) return decodeTextBuffer(buffer);
  if (lowerExt === '.xml') return xmlText(decodeTextBuffer(buffer));
  if (['.html', '.htm'].includes(lowerExt)) return normalizeExtractedText(stripHtmlText(decodeTextBuffer(buffer)));
  if (lowerExt === '.rtf') return normalizeExtractedText(stripRtfText(decodeTextBuffer(buffer)));
  if (lowerExt === '.docx') return extractDocxText(buffer);
  if (lowerExt === '.pptx') return extractPptxText(buffer);
  if (lowerExt === '.xlsx') return extractXlsxText(buffer);
  if (lowerExt === '.pdf') return extractPdfText(buffer);
  throw new Error('暂不支持该文档类型');
}

// REGION: Storage Path Resolution
function normalizeLocalPath(input) {
  return path.resolve(String(input || '').trim());
}

function defaultKnowledgeBaseFolder(kb) {
  const folderName = kb.folderPath
    ? path.basename(kb.folderPath)
    : `${safeFolderName(kb.name || kb.id)}_${kb.id}`;
  return path.join(KNOWLEDGE_BASES_DIR, folderName);
}

function ensureKnowledgeBasePath(kb) {
  if (!kb.folderPath || kb.useDefaultPath !== false) {
    kb.useDefaultPath = true;
    kb.folderPath = defaultKnowledgeBaseFolder(kb);
  }
  fs.mkdirSync(kb.folderPath, { recursive: true });
}

function resolveDocumentPath(doc, kb) {
  if (doc.filePath && fs.existsSync(doc.filePath)) return doc.filePath;
  if (!doc.filePath) return '';
  const folderPath = kb?.folderPath || '';
  const portablePath = folderPath ? path.join(folderPath, path.basename(doc.filePath)) : '';
  if (portablePath && fs.existsSync(portablePath)) {
    doc.filePath = portablePath;
    return portablePath;
  }
  return doc.filePath;
}

function resolveLogPath(log) {
  if (log.filePath && fs.existsSync(log.filePath)) return log.filePath;
  if (!log.filePath) return '';
  const bucket = log.bucket || logBucket(log.createdAt);
  const portablePath = path.join(LOGS_DIR, bucket.date, bucket.timeLevel, path.basename(log.filePath));
  if (fs.existsSync(portablePath)) {
    log.filePath = portablePath;
    return portablePath;
  }
  return log.filePath;
}

function refreshKnowledgeBaseStats(db, knowledgeBaseId) {
  const kb = db.knowledgeBases.find(item => item.id === knowledgeBaseId);
  if (!kb) return;
  kb.documentCount = db.documents.filter(doc => doc.knowledgeBaseId === knowledgeBaseId).length;
  kb.updatedAt = new Date().toISOString();
}

// REGION: Local Vectorization And Retrieval
function tokenize(text) {
  const normalized = String(text || '').toLowerCase();
  const tokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) || [];
  const chineseChars = normalized.match(/[\u4e00-\u9fff]/g) || [];
  for (let i = 0; i < chineseChars.length - 1; i += 1) {
    tokens.push(chineseChars[i] + chineseChars[i + 1]);
  }
  return tokens.filter(token => token.trim());
}

function vectorizeText(text) {
  const vector = {};
  for (const token of tokenize(text)) {
    vector[token] = (vector[token] || 0) + 1;
  }
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of Object.values(a)) aNorm += value * value;
  for (const value of Object.values(b)) bNorm += value * value;
  for (const [token, value] of Object.entries(a)) {
    dot += value * (b[token] || 0);
  }
  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function chunkText(text, size = 500, overlap = 100) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const content = clean.slice(start, start + size).trim();
    if (content) chunks.push(content);
    start += size - overlap;
  }
  return chunks;
}

function processDocumentToChunks(db, doc, content) {
  db.chunks = db.chunks.filter(chunk => chunk.documentId !== doc.id);
  const now = new Date().toISOString();
  const chunks = chunkText(content).map((chunkContent, index) => ({
    id: `chunk_${doc.id}_${index}`,
    knowledgeBaseId: doc.knowledgeBaseId,
    documentId: doc.id,
    fileType: doc.fileType,
    filename: doc.filename,
    chunkIndex: index + 1,
    content: chunkContent,
    vector: vectorizeText(chunkContent),
    createdAt: now
  }));
  db.chunks.push(...chunks);
  doc.status = '已处理';
  doc.chunkCount = chunks.length;
  doc.updatedAt = now;
}

function retrieveChunks(db, knowledgeBaseId, question, topK = 10, documentIds = []) {
  const questionVector = vectorizeText(question);
  const docSet = new Set(documentIds);
  const docMap = new Map(db.documents.map(doc => [doc.id, doc]));
  return db.chunks
    .filter(chunk => chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(chunk => !docSet.size || docSet.has(chunk.documentId))
    .map(chunk => ({
      ...chunk,
      fileType: chunk.fileType || docMap.get(chunk.documentId)?.fileType || '',
      score: cosineSimilarity(questionVector, chunk.vector || {})
    }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function runChunkSearchWorker(chunks, questionVector, topK) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CHUNK_SEARCH_WORKER, {
      workerData: { chunks, questionVector, topK }
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`检索线程异常退出：${code}`));
    });
  });
}

async function retrieveChunksParallel(db, knowledgeBaseId, question, topK = 10, documentIds = []) {
  const questionVector = vectorizeText(question);
  const docSet = new Set(documentIds);
  const docMap = new Map(db.documents.map(doc => [doc.id, doc]));
  const chunks = db.chunks
    .filter(chunk => chunk.knowledgeBaseId === knowledgeBaseId)
    .filter(chunk => !docSet.size || docSet.has(chunk.documentId))
    .map(chunk => ({
      id: chunk.id,
      knowledgeBaseId: chunk.knowledgeBaseId,
      documentId: chunk.documentId,
      fileType: chunk.fileType || docMap.get(chunk.documentId)?.fileType || '',
      filename: chunk.filename,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      vector: chunk.vector
    }));

  if (chunks.length < 1200) return retrieveChunks(db, knowledgeBaseId, question, topK, documentIds);

  const workerCount = Math.min(Math.max(2, os.cpus().length - 1), 4, chunks.length);
  const batchSize = Math.ceil(chunks.length / workerCount);
  const batches = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push(chunks.slice(i, i + batchSize));
  }

  const results = await Promise.all(batches.map(batch => runChunkSearchWorker(batch, questionVector, topK)));
  return results
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function representativeChunks(db, knowledgeBaseId, documentIds = [], maxPerDocument = 20) {
  const docSet = new Set(documentIds);
  const docs = db.documents
    .filter(doc => doc.knowledgeBaseId === knowledgeBaseId)
    .filter(doc => !docSet.size || docSet.has(doc.id));
  const selected = [];
  for (const doc of docs) {
    const chunks = db.chunks
      .filter(chunk => chunk.documentId === doc.id)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (!chunks.length) continue;

    const indexes = new Set();
    for (let i = 0; i < Math.min(5, chunks.length); i += 1) indexes.add(i);
    for (let i = Math.max(0, chunks.length - 3); i < chunks.length; i += 1) indexes.add(i);
    const middleCount = Math.max(0, maxPerDocument - indexes.size);
    for (let i = 1; i <= middleCount; i += 1) {
      indexes.add(Math.floor((chunks.length - 1) * (i / (middleCount + 1))));
    }

    for (const index of Array.from(indexes).sort((a, b) => a - b)) {
      const chunk = chunks[index];
      selected.push({
        ...chunk,
        fileType: chunk.fileType || doc.fileType || '',
        score: chunk.score || 0.01,
        representative: true
      });
    }
  }
  return selected;
}

// REGION: DeepSeek Chat Integration
async function callDeepSeek(messages, signal) {
  if (!AI_CONFIG.apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中配置 DeepSeek API Key');
  }
  const response = await fetch(`${AI_CONFIG.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_CONFIG.apiKey}`
    },
    body: JSON.stringify({
      model: AI_CONFIG.chatModel,
      messages,
      temperature: 0.35,
      reasoning: { enabled: true }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `DeepSeek 调用失败：${response.status}`);
  }
  return {
    answer: data.choices?.[0]?.message?.content || '',
    reasoning: data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || '',
    usage: data.usage || {}
  };
}

function selectDiverseHits(hits, limit = 10) {
  const selected = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = `${hit.documentId}:${hit.chunkIndex}`;
    if (seen.has(key)) continue;
    selected.push(hit);
    seen.add(key);
    if (selected.length >= limit) break;
  }
  return selected;
}

function mergeContextHits(primaryHits, extraHits, limit = 32) {
  const selected = [];
  const seen = new Set();
  for (const hit of [...primaryHits, ...extraHits]) {
    const key = hit.id || `${hit.documentId}:${hit.chunkIndex}`;
    if (seen.has(key)) continue;
    selected.push(hit);
    seen.add(key);
    if (selected.length >= limit) break;
  }
  return selected;
}

function buildContextFromHits(hits, maxChars = 28000) {
  let used = 0;
  const blocks = [];
  for (const [index, hit] of hits.entries()) {
    const remain = maxChars - used;
    if (remain <= 0) break;
    const content = cleanDisplayText(hit.content).slice(0, Math.min(1200, remain));
    const block = [
      `引用 ${index + 1}`,
      `文档：${hit.filename}`,
      `片段：${hit.chunkIndex}`,
      `类型：${hit.representative ? '文档代表片段' : '相关片段'}`,
      `内容：${content}`
    ].join('\n');
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

function buildChatMessages(kb, context, question, largeModeNote = '') {
  return [
    {
      role: 'system',
      content: [
        '你是“知枢 AI 知识库平台”的智能助手。',
        '你的回答要自然、像一个有经验的同事在解释问题，而不是机械复读资料片段。',
        '你需要先理解用户真实意图，再综合知识库片段回答。',
        '可以归纳、重组、解释、补充必要的上下文，但不要编造知识库里没有的事实。',
        '如果资料不足，要明确说“当前知识库没有足够信息”，并说明还缺什么。',
        '回答优先给结论，再给关键依据；不要逐条照抄 chunk。',
        '如果用户问的是总结、分析、方案、步骤，请主动组织成清晰结构。',
        '如果用户只是问简单事实，直接简洁回答。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `知识库名称：${kb.name}`,
        largeModeNote,
        '',
        '下面是系统从知识库中检索到的参考资料。它们可能不完整，也可能只有部分相关。请你综合判断后回答。',
        '',
        context,
        '',
        `用户问题：${question}`,
        '',
        '回答要求：',
        '1. 不要说“根据引用1/2”这种机械话术，除非用户明确要求追溯依据。',
        '2. 可以自然地说“从资料看”“目前文档里能确定的是”。',
        '3. 如果多个片段表达同一件事，请合并成一句清楚的话。',
        '4. 如果问题需要推理，请说明你的判断过程，但保持简洁。'
      ].filter(Boolean).join('\n')
    }
  ];
}

function callDeepSeekWithTimeout(messages, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return callDeepSeek(messages, controller.signal)
    .catch(error => {
      if (error.name === 'AbortError') throw new Error('AI 回复超时，请缩小文档范围或稍后重试');
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

function shouldShowRelevance(question) {
  const text = String(question || '').toLowerCase();
  return /相关度|相似度|引用|来源|依据|证据|命中|检索|chunk|片段|为什么/.test(text);
}

function shouldShowCitations(question) {
  const text = String(question || '').toLowerCase();
  return /引用|来源|原文|依据|证据|哪[里儿]|位置|出处|片段|chunk|第几|章节|段落|证明|小说|剧情|情节|高潮|转折|冲突|对话|描写|人物|角色|章节|桥段|片段|名场面|关键情节|精彩片段/.test(text);
}

function shouldForceVisualCitations(hits) {
  return hits.some(hit => ['image', 'table', 'pdf'].includes(citationSourceKind(hit.fileType)));
}

function quickCitations(hits) {
  return hits.slice(0, 4).map(hit => ({
    id: hit.id,
    documentId: hit.documentId,
    filename: hit.filename,
    fileType: hit.fileType,
    chunkIndex: hit.chunkIndex,
    score: Number(hit.score.toFixed(4)),
    content: cleanDisplayText(hit.content).slice(0, 180),
    reason: '快速模式直接采用本地检索命中的高相关片段。'
  }));
}

function parseJsonArray(value) {
  const text = stripInvalidControlChars(value).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const data = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function citationSourceKind(fileType) {
  const type = String(fileType || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'].includes(type)) return 'image';
  if (['csv', 'xlsx'].includes(type)) return 'table';
  if (type === 'pdf') return 'pdf';
  return 'text';
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:]{2,}/g, match => match[0])
    .replace(/[《<]\s*/g, '《')
    .replace(/\s*[》>]/g, '》')
    .trim();
}

async function polishVisualCitationText(question, answer, citations) {
  const visualCitations = citations.filter(item => ['image', 'table', 'pdf'].includes(citationSourceKind(item.fileType)));
  if (!visualCitations.length) return citations;

  const payload = visualCitations.map(item => ({
    id: item.id,
    filename: item.filename,
    type: citationSourceKind(item.fileType),
    rawText: normalizeOcrText(item.content)
  }));

  try {
    const result = await callDeepSeekWithTimeout([
      {
        role: 'system',
        content: [
          '你负责清洗 OCR/表格识别出来的引用文字。',
          '任务是修正明显的空格、乱码标点、缺字多字造成的不通顺表达。',
          '不要新增原文没有的事实，不要扩写，不要改写成总结。',
          '如果无法确定，只做最小清洗，保留原意。',
          '输出 JSON 数组，不要输出解释文字。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `用户问题：${question}`,
          '',
          `AI回答：${answer}`,
          '',
          `待清洗引用：${JSON.stringify(payload, null, 2)}`,
          '',
          '输出格式：',
          '[{"id":"引用id","cleanText":"清洗后的关键文字"}]'
        ].join('\n')
      }
    ], 90000);
    const cleaned = parseJsonArray(result.answer);
    const cleanMap = new Map(cleaned.map(item => [String(item.id || ''), String(item.cleanText || '').trim()]));
    return citations.map(item => {
      const cleanText = cleanMap.get(item.id);
      if (!cleanText) return item;
      return {
        ...item,
        rawText: item.content,
        content: cleanText,
        keyText: cleanText,
        textPolished: true
      };
    });
  } catch {
    return citations.map(item => ['image', 'table', 'pdf'].includes(citationSourceKind(item.fileType))
      ? { ...item, content: normalizeOcrText(item.content), keyText: normalizeOcrText(item.content) }
      : item);
  }
}

function enrichCitationText(citations, db) {
  return citations.map(item => {
    const doc = db.documents.find(document => document.id === item.documentId);
    const fileType = item.fileType || doc?.fileType || '';
    const sourceKind = citationSourceKind(fileType);
    return {
      ...item,
      fileType,
      sourceKind,
      keyText: item.keyText || item.content,
      reason: item.reason || (sourceKind === 'text'
        ? '这段文字可以支撑回答。'
        : '该内容由系统从非纯文本文件中自动识别并提取，不作为原文直接引用。')
    };
  });
}

function fallbackVisualCitations(hits) {
  return hits
    .filter(hit => ['image', 'table', 'pdf'].includes(citationSourceKind(hit.fileType)))
    .slice(0, 4)
    .map(hit => ({
      id: hit.id,
      documentId: hit.documentId,
      filename: hit.filename,
      fileType: hit.fileType,
      chunkIndex: hit.chunkIndex,
      score: Number(hit.score.toFixed(4)),
      content: String(hit.content || '').slice(0, 220),
      reason: '该文档属于图片、表格或 PDF 类型，系统已自动识别并提取关键文字。'
    }));
}

async function analyzeCitationSnippets(question, answer, hits) {
  if (!hits.length) return { citations: [], reasoning: '' };
  const candidates = hits.map((hit, index) => [
    `候选 ${index + 1}`,
    `chunkId：${hit.id}`,
    `文档：${hit.filename}`,
    `片段编号：${hit.chunkIndex}`,
    `相关度：${Number(hit.score.toFixed(4))}`,
    `片段内容：${cleanDisplayText(hit.content)}`
  ].join('\n')).join('\n\n');

  const result = await callDeepSeekWithTimeout([
    {
      role: 'system',
      content: [
        '你负责为知识库问答挑选真正需要展示给用户的原文引用。',
        '不要整段照搬 chunk，只截取能支撑回答的最小必要原文。',
        '如果候选来自 PDF、图片、表格等 OCR/识别内容，可以先选出最相关内容，后续会单独清洗文字。',
        'OCR 中明显多余的空格可以去掉，但不要在这里大幅改写。',
        '如果某个 chunk 只是背景、重复内容或没有直接支撑回答，不要引用。',
        '每条 quote 尽量控制在 20 到 180 字。',
        '只输出 JSON 数组，不要输出解释文字。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `用户问题：${question}`,
        '',
        `AI 回答：${answer}`,
        '',
        '候选 chunk：',
        candidates,
        '',
        '输出格式：',
        '[{"chunkId":"chunk id","quote":"真正需要引用的原文摘录","reason":"这段原文支撑了回答中的哪一点"}]'
      ].join('\n')
    }
  ], 90000);

  const selected = parseJsonArray(result.answer);
  const byId = new Map(hits.map(hit => [hit.id, hit]));
  const usedIds = new Set();
  const citations = selected
    .map(item => {
      const hit = byId.get(String(item.chunkId || ''));
      const quote = cleanDisplayText(item.quote);
      if (!hit || !quote) return null;
      if (usedIds.has(hit.id)) return null;
      usedIds.add(hit.id);
      return {
        id: hit.id,
        documentId: hit.documentId,
        filename: hit.filename,
        fileType: hit.fileType,
        chunkIndex: hit.chunkIndex,
        score: Number(hit.score.toFixed(4)),
        content: quote,
        reason: cleanDisplayText(item.reason)
      };
    })
    .filter(Boolean)
    .slice(0, 6);

  return { citations, reasoning: result.reasoning || result.answer };
}

// REGION: Log File Helpers
function logTitle(question) {
  const text = String(question || '').replace(/\s+/g, ' ').trim();
  return text.length > 28 ? `${text.slice(0, 28)}...` : text || '未命名问答';
}

function logBucket(dateValue) {
  const date = new Date(dateValue);
  const hour = date.getHours();
  let timeLevel = '夜间';
  if (hour >= 6 && hour < 12) timeLevel = '上午';
  if (hour >= 12 && hour < 18) timeLevel = '下午';
  if (hour >= 18 && hour < 24) timeLevel = '晚上';
  return {
    date: date.toISOString().slice(0, 10),
    timeLevel
  };
}

function safeLogFileName(value) {
  return String(value || '未命名日志').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 60);
}

function writeAiLogFile(log, exportRoot = LOGS_DIR) {
  const bucket = log.bucket || logBucket(log.createdAt);
  const dir = path.join(exportRoot, bucket.date, bucket.timeLevel);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${safeLogFileName(log.title)}_${log.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2), 'utf8');
  log.filePath = filePath;
  log.exported = true;
  log.exportedAt = new Date().toISOString();
}

// REGION: Static File Server
function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const filePath = urlPath === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, urlPath);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  });
}

// REGION: API Routes
async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, name: '知枢 AI 知识库平台' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/avatars') {
    sendJson(res, 200, { items: AVATAR_IDS });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const passwordConfirm = String(body.passwordConfirm || '');
    const role = body.role === 'admin' ? 'admin' : 'user';

    if (!username || !password) {
      sendJson(res, 400, { error: '用户名和密码不能为空' });
      return;
    }
    if (password !== passwordConfirm) {
      sendJson(res, 400, { error: '两次输入的密码不一致' });
      return;
    }
    if (role === 'admin' && String(body.adminKey || '') !== requireAdminRegisterKey()) {
      sendJson(res, 400, { error: '管理员密钥错误' });
      return;
    }

    const db = readDb();
    if (db.users.some(user => user.username === username)) {
      sendJson(res, 409, { error: '用户名已存在' });
      return;
    }
    const { salt, hash } = hashPassword(password);
    const avatarId = normalizeAvatarId(body.avatarId);
    const now = new Date().toISOString();
    const user = {
      id: `user_${Date.now()}`,
      username,
      role,
      salt,
      passwordHash: hash,
      avatarId,
      brandAvatarId: 'wolf',
      busyAvatarId: 'wolf',
      aiAvatarId: 'wolf',
      createdAt: now,
      updatedAt: now
    };
    db.users.push(user);
    writeDb(db);
    sendJson(res, 201, { user: publicUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readBody(req);
    const db = readDb();
    const user = db.users.find(item => item.username === String(body.username || '').trim());
    if (!user || !verifyPassword(String(body.password || ''), user)) {
      sendJson(res, 401, { error: '用户名或密码错误' });
      return;
    }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/user') {
    const userId = String(url.searchParams.get('id') || '');
    const user = readDb().users.find(item => item.id === userId);
    if (!user) {
      sendJson(res, 404, { error: '用户不存在，请重新登录' });
      return;
    }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/change-password') {
    const body = await readBody(req);
    const db = readDb();
    const user = db.users.find(item => item.id === String(body.userId || ''));
    if (!user) {
      sendJson(res, 404, { error: '用户不存在' });
      return;
    }
    if (!verifyPassword(String(body.oldPassword || ''), user)) {
      sendJson(res, 400, { error: '原密码错误' });
      return;
    }
    const newPassword = String(body.newPassword || '');
    if (!newPassword || newPassword !== String(body.newPasswordConfirm || '')) {
      sendJson(res, 400, { error: '新密码不能为空，且两次输入必须一致' });
      return;
    }
    const { salt, hash } = hashPassword(newPassword);
    user.salt = salt;
    user.passwordHash = hash;
    user.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/preferences') {
    const body = await readBody(req);
    const db = readDb();
    const user = db.users.find(item => item.id === String(body.userId || ''));
    if (!user) {
      sendJson(res, 404, { error: '用户不存在' });
      return;
    }
    user.avatarId = normalizeAvatarId(body.avatarId ?? user.avatarId);
    user.brandAvatarId = normalizeAvatarId(body.brandAvatarId ?? user.brandAvatarId);
    user.busyAvatarId = normalizeAvatarId(body.busyAvatarId ?? user.busyAvatarId);
    user.aiAvatarId = normalizeAvatarId(body.aiAvatarId ?? user.aiAvatarId);
    user.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    const adminId = String(url.searchParams.get('userId') || '');
    const db = readDb();
    const admin = db.users.find(item => item.id === adminId);
    if (!admin || admin.role !== 'admin') {
      sendJson(res, 403, { error: '只有管理员可以查看用户列表' });
      return;
    }
    const items = db.users.map(user => ({
      id: user.id,
      username: user.username,
      role: user.role,
      avatarId: user.avatarId || 'wolf',
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      password: '密码已加密保存，无法查看原文'
    }));
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/reset-password') {
    const body = await readBody(req);
    const db = readDb();
    const admin = db.users.find(item => item.id === String(body.adminId || ''));
    if (!admin || admin.role !== 'admin') {
      sendJson(res, 403, { error: '只有管理员可以重置密码' });
      return;
    }
    const target = db.users.find(item => item.id === String(body.targetUserId || ''));
    if (!target) {
      sendJson(res, 404, { error: '目标用户不存在' });
      return;
    }
    const newPassword = String(body.newPassword || '');
    if (!newPassword || newPassword !== String(body.newPasswordConfirm || '')) {
      sendJson(res, 400, { error: '新密码不能为空，且两次输入必须一致' });
      return;
    }
    const { salt, hash } = hashPassword(newPassword);
    target.salt = salt;
    target.passwordHash = hash;
    target.updatedAt = new Date().toISOString();
    writeDb(db);
    sendJson(res, 200, { ok: true, user: publicUser(target) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/select-folder') {
    const body = await readBody(req);
    const folderPath = await selectFolder(body.title || '请选择文件夹');
    sendJson(res, 200, { folderPath });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/knowledge-bases') {
    const db = readDb();
    for (const kb of db.knowledgeBases) {
      ensureKnowledgeBasePath(kb);
      kb.documentCount = db.documents.filter(doc => doc.knowledgeBaseId === kb.id).length;
    }
    writeDb(db);
    sendJson(res, 200, { items: db.knowledgeBases });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/knowledge-bases') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    const useDefaultPath = body.useDefaultPath !== false;
    const customPath = String(body.customPath || '').trim();

    if (!name) {
      sendJson(res, 400, { error: '知识库名称不能为空' });
      return;
    }
    if (!useDefaultPath && !customPath) {
      sendJson(res, 400, {
        error: `创建失败：未选择知识库文件夹。解决方案：勾选“使用默认路径”，或填写一个知识库文件夹路径。默认知识库目录：${KNOWLEDGE_BASES_DIR}`
      });
      return;
    }

    const now = new Date().toISOString();
    const id = `kb_${Date.now()}`;
    const folderPath = useDefaultPath
      ? path.join(KNOWLEDGE_BASES_DIR, `${safeFolderName(name)}_${id}`)
      : normalizeLocalPath(customPath);
    const kb = {
      id,
      name,
      description,
      useDefaultPath,
      folderPath,
      documentCount: 0,
      createdAt: now,
      updatedAt: now
    };

    fs.mkdirSync(folderPath, { recursive: true });
    const db = readDb();
    db.knowledgeBases.unshift(kb);
    writeDb(db);
    sendJson(res, 201, kb);
    return;
  }

  const openKbMatch = url.pathname.match(/^\/api\/knowledge-bases\/([^/]+)\/open-folder$/);
  if (req.method === 'POST' && openKbMatch) {
    const knowledgeBaseId = decodeURIComponent(openKbMatch[1]);
    const db = readDb();
    const kb = db.knowledgeBases.find(item => item.id === knowledgeBaseId);
    if (!kb) {
      sendJson(res, 404, { error: '知识库不存在' });
      return;
    }
    ensureKnowledgeBasePath(kb);
    writeDb(db);
    await openInExplorer(path.resolve(kb.folderPath));
    sendJson(res, 200, { ok: true });
    return;
  }

  const deleteKbMatch = url.pathname.match(/^\/api\/knowledge-bases\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteKbMatch) {
    const knowledgeBaseId = decodeURIComponent(deleteKbMatch[1]);
    const db = readDb();
    const index = db.knowledgeBases.findIndex(item => item.id === knowledgeBaseId);
    if (index === -1) {
      sendJson(res, 404, { error: '知识库不存在' });
      return;
    }

    const [kb] = db.knowledgeBases.splice(index, 1);
    const docs = db.documents.filter(doc => doc.knowledgeBaseId === knowledgeBaseId);
    ensureKnowledgeBasePath(kb);
    for (const doc of docs) {
      const filePath = resolveDocumentPath(doc, kb);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    db.documents = db.documents.filter(doc => doc.knowledgeBaseId !== knowledgeBaseId);
    db.chunks = db.chunks.filter(chunk => chunk.knowledgeBaseId !== knowledgeBaseId);
    db.chatMessages = db.chatMessages.filter(message => message.knowledgeBaseId !== knowledgeBaseId);
    removeDirIfEmpty(kb.folderPath);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const knowledgeBaseId = url.searchParams.get('knowledgeBaseId');
    const db = readDb();
    const kbMap = new Map(db.knowledgeBases.map(kb => {
      ensureKnowledgeBasePath(kb);
      return [kb.id, kb];
    }));
    for (const doc of db.documents) {
      resolveDocumentPath(doc, kbMap.get(doc.knowledgeBaseId));
    }
    writeDb(db);
    const items = knowledgeBaseId
      ? db.documents.filter(doc => doc.knowledgeBaseId === knowledgeBaseId)
      : db.documents;
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/chat-history') {
    const db = readDb();
    const items = db.chatMessages.map(item => ({
      id: item.id,
      knowledgeBaseId: item.knowledgeBaseId,
      knowledgeBaseName: db.knowledgeBases.find(kb => kb.id === item.knowledgeBaseId)?.name || item.knowledgeBaseName || '未知知识库',
      documentIds: item.documentIds || [],
      question: item.question,
      answer: item.answer,
      createdAt: item.createdAt,
      model: item.model,
      answerMode: item.answerMode || 'thinking'
    }));
    sendJson(res, 200, { items });
    return;
  }

  const chatHistoryMatch = url.pathname.match(/^\/api\/chat-history\/([^/]+)$/);
  if (req.method === 'GET' && chatHistoryMatch) {
    const chatId = decodeURIComponent(chatHistoryMatch[1]);
    const db = readDb();
    const item = db.chatMessages.find(chat => chat.id === chatId);
    if (!item) {
      sendJson(res, 404, { error: '聊天记录不存在' });
      return;
    }
    sendJson(res, 200, item);
    return;
  }

  if (req.method === 'DELETE' && chatHistoryMatch) {
    const chatId = decodeURIComponent(chatHistoryMatch[1]);
    const db = readDb();
    const before = db.chatMessages.length;
    db.chatMessages = db.chatMessages.filter(chat => chat.id !== chatId);
    if (db.chatMessages.length === before) {
      sendJson(res, 404, { error: '聊天记录不存在' });
      return;
    }
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req);
    const knowledgeBaseId = String(body.knowledgeBaseId || '').trim();
    const question = String(body.question || '').trim();
    const answerMode = body.answerMode === 'fast' ? 'fast' : 'thinking';
    const documentIds = Array.isArray(body.documentIds)
      ? body.documentIds.map(item => String(item)).filter(Boolean)
      : [];

    if (!knowledgeBaseId) {
      sendJson(res, 400, { error: '请选择知识库' });
      return;
    }
    if (!question) {
      sendJson(res, 400, { error: '问题不能为空' });
      return;
    }

    const db = readDb();
    const kb = db.knowledgeBases.find(item => item.id === knowledgeBaseId);
    if (!kb) {
      sendJson(res, 404, { error: '知识库不存在' });
      return;
    }
    if (documentIds.length) {
      const validDocIds = new Set(db.documents
        .filter(doc => doc.knowledgeBaseId === knowledgeBaseId)
        .map(doc => doc.id));
      const invalid = documentIds.filter(id => !validDocIds.has(id));
      if (invalid.length) {
        sendJson(res, 400, { error: '选择的文档不属于当前知识库' });
        return;
      }
    }

    const fastMode = answerMode === 'fast';
    const searchTask = retrieveChunksParallel(db, knowledgeBaseId, question, fastMode ? 18 : 60, documentIds);
    const representativeHits = fastMode ? [] : representativeChunks(db, knowledgeBaseId, documentIds, 20);
    const searchHits = selectDiverseHits(await searchTask, fastMode ? 8 : 24);
    const hits = fastMode ? searchHits : mergeContextHits(searchHits, representativeHits, 36);
    if (!hits.length) {
      sendJson(res, 400, { error: '没有检索到相关文档片段，请先上传包含相关内容的文档，或调整选择的文档范围。' });
      return;
    }

    const context = buildContextFromHits(hits, fastMode ? 6000 : 28000);
    let messages = buildChatMessages(kb, context, question, fastMode
      ? '当前为快速模式：系统只提供最相关的少量片段，请优先快速、简洁回答；如果资料不足，直接说明。'
      : '当前为思考模式：系统已同时提供相关片段和文档代表片段。');

    const startedAt = Date.now();
    let result;
    if (fastMode) {
      result = await callDeepSeekWithTimeout(messages, 10000);
    } else {
      try {
        result = await callDeepSeekWithTimeout(messages, 180000);
      } catch (error) {
        const fallbackHits = mergeContextHits(searchHits, representativeHits, 20);
        const fallbackContext = buildContextFromHits(fallbackHits, 14000);
        messages = buildChatMessages(kb, fallbackContext, question, '第一次大上下文调用失败，系统已自动改用压缩上下文重试。');
        result = await callDeepSeekWithTimeout(messages, 120000);
      }
    }
    if (!String(result.answer || '').trim()) {
      throw new Error('AI 返回了空内容，请稍后重试或缩小文档范围');
    }
    const now = new Date().toISOString();
    const shouldDisplayCitations = shouldShowCitations(question) || shouldForceVisualCitations(hits);
    const highRelevanceHits = hits.filter(hit => hit.score >= 0.7);
    const citationCandidates = highRelevanceHits.length ? highRelevanceHits : hits.slice(0, 6);
    const citationAnalysis = fastMode
      ? { citations: shouldDisplayCitations ? quickCitations(citationCandidates) : [], reasoning: '快速模式跳过二次引用分析。' }
      : (shouldDisplayCitations
        ? await analyzeCitationSnippets(question, result.answer, citationCandidates)
        : { citations: [], reasoning: '' });
    if (!fastMode && shouldDisplayCitations && !citationAnalysis.citations.length && shouldForceVisualCitations(hits)) {
      citationAnalysis.citations = fallbackVisualCitations(hits);
    }
    const latencyMs = Date.now() - startedAt;
    const polishedCitations = fastMode
      ? citationAnalysis.citations
      : await polishVisualCitationText(question, result.answer, citationAnalysis.citations);
    const citationHits = enrichCitationText(polishedCitations, db);
    const record = {
      id: `chat_${Date.now()}`,
      knowledgeBaseId,
      documentIds,
      question,
      answer: result.answer,
      citations: citationHits,
      citationDecision: shouldDisplayCitations
        ? (citationHits.length ? 'show' : 'none-high-relevance')
        : 'ai-summary',
      answerMode,
      showRelevance: shouldShowRelevance(question),
      model: AI_CONFIG.chatModel,
      latencyMs,
      usage: result.usage,
      createdAt: now
    };

    const log = {
      id: `log_${Date.now()}`,
      title: logTitle(question),
      chatId: record.id,
      knowledgeBaseId,
      knowledgeBaseName: db.knowledgeBases.find(item => item.id === knowledgeBaseId)?.name || kb.name,
      documentIds,
      question,
      answerMode,
      retrievedChunks: hits.map(hit => ({
        id: hit.id,
        documentId: hit.documentId,
        filename: hit.filename,
        chunkIndex: hit.chunkIndex,
        score: Number(hit.score.toFixed(4)),
        content: hit.content
      })),
      citationAnalysis,
      messages,
      answer: result.answer,
      reasoning: result.reasoning,
      model: AI_CONFIG.chatModel,
      latencyMs,
      usage: result.usage,
      createdAt: now,
      bucket: logBucket(now)
    };
    db.chatMessages.unshift(record);
    db.aiLogs.unshift(log);
    writeDb(db);
    sendJson(res, 200, { ...record, logId: log.id });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const db = readDb();
    let changed = false;
    for (const log of db.aiLogs) {
      const filePath = resolveLogPath(log);
      if (log.exported && (!filePath || !fs.existsSync(filePath))) {
        log.exported = false;
        log.filePath = '';
        changed = true;
      }
    }
    if (changed) writeDb(db);
    const items = db.aiLogs.map(log => ({
      id: log.id,
      title: log.title || logTitle(log.question),
      knowledgeBaseName: log.knowledgeBaseName,
      question: log.question,
      model: log.model,
      latencyMs: log.latencyMs,
      usage: log.usage,
      createdAt: log.createdAt,
      bucket: log.bucket || logBucket(log.createdAt),
      filePath: log.filePath,
      exported: !!log.exported,
      exportedAt: log.exportedAt
    }));
    sendJson(res, 200, { items });
    return;
  }

  const logDetailMatch = url.pathname.match(/^\/api\/logs\/([^/]+)$/);
  if (req.method === 'GET' && logDetailMatch) {
    const logId = decodeURIComponent(logDetailMatch[1]);
    const db = readDb();
    const log = db.aiLogs.find(item => item.id === logId);
    if (!log) {
      sendJson(res, 404, { error: '日志不存在' });
      return;
    }
    sendJson(res, 200, log);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logs/export') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const useDefaultPath = body.useDefaultPath !== false;
    const customPath = String(body.customPath || '').trim();
    if (!useDefaultPath && !customPath) {
      sendJson(res, 400, { error: `导出失败：未选择日志导出文件夹。请勾选默认路径，或点击“选择文件夹”自选导出位置。默认路径：${LOGS_DIR}` });
      return;
    }
    const exportRoot = useDefaultPath ? LOGS_DIR : normalizeLocalPath(customPath);
    const db = readDb();
    const selected = ids.length
      ? db.aiLogs.filter(log => ids.includes(log.id))
      : db.aiLogs;
    if (!selected.length) {
      sendJson(res, 400, { error: '没有可导出的日志' });
      return;
    }
    for (const log of selected) {
      writeAiLogFile(log, exportRoot);
    }
    writeDb(db);
    sendJson(res, 200, { ok: true, count: selected.length });
    return;
  }

  if (req.method === 'DELETE' && logDetailMatch) {
    const logId = decodeURIComponent(logDetailMatch[1]);
    const db = readDb();
    const before = db.aiLogs.length;
    const log = db.aiLogs.find(item => item.id === logId);
    db.aiLogs = db.aiLogs.filter(item => item.id !== logId);
    if (db.aiLogs.length === before) {
      sendJson(res, 404, { error: '日志不存在' });
      return;
    }
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  const openLogMatch = url.pathname.match(/^\/api\/logs\/([^/]+)\/open-location$/);
  if (req.method === 'POST' && openLogMatch) {
    const logId = decodeURIComponent(openLogMatch[1]);
    const db = readDb();
    const log = db.aiLogs.find(item => item.id === logId);
    if (!log) {
      sendJson(res, 404, { error: '日志不存在' });
      return;
    }
    const filePath = resolveLogPath(log);
    if (!log.exported || !filePath || !fs.existsSync(filePath)) {
      sendJson(res, 400, { error: '日志尚未导出，请先导出日志后再打开位置' });
      return;
    }
    writeDb(db);
    await openInExplorer(filePath, true);
    sendJson(res, 200, { ok: true, filePath });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/documents') {
    const body = await readBody(req);
    const knowledgeBaseId = String(body.knowledgeBaseId || '').trim();
    const filename = safeFileName(body.filename);
    const ext = path.extname(filename).toLowerCase();
    const fileBuffer = body.contentBase64
      ? Buffer.from(String(body.contentBase64), 'base64')
      : Buffer.from(String(body.content || ''), 'utf8');

    if (!knowledgeBaseId) {
      sendJson(res, 400, { error: '请选择知识库' });
      return;
    }
    if (!isSupportedDocument(ext)) {
      sendJson(res, 400, { error: '不支持该文档类型。当前支持：md、txt、log、csv、json、html、xml、rtf、docx、pptx、xlsx、pdf、png、jpg、jpeg、bmp、tif、tiff' });
      return;
    }
    if (!fileBuffer.length) {
      sendJson(res, 400, { error: '文档文件不能为空' });
      return;
    }

    const db = readDb();
    const kb = db.knowledgeBases.find(item => item.id === knowledgeBaseId);
    if (!kb) {
      sendJson(res, 404, { error: '知识库不存在' });
      return;
    }
    ensureKnowledgeBasePath(kb);

    const targetDir = kb.folderPath;
    fs.mkdirSync(targetDir, { recursive: true });
    const now = new Date().toISOString();
    const id = `doc_${Date.now()}`;
    const storedName = `${id}_${filename}`;
    const filePath = path.join(targetDir, storedName);
    fs.writeFileSync(filePath, fileBuffer);

    let extractedText = '';
    let usedOcr = false;
    try {
      extractedText = extractTextFromDocument(fileBuffer, ext);
      if ((!extractedText.trim() || isLikelyGarbledText(extractedText)) && OCR_DOCUMENT_EXTENSIONS.has(ext)) {
        extractedText = await extractTextWithAiOcr(filePath, ext);
        usedOcr = true;
      }
    } catch (error) {
      if (OCR_DOCUMENT_EXTENSIONS.has(ext)) {
        try {
          extractedText = await extractTextWithAiOcr(filePath, ext);
          usedOcr = true;
        } catch (ocrError) {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          sendJson(res, 400, { error: `文档解析失败：${ocrError.message}` });
          return;
        }
      } else {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        sendJson(res, 400, { error: `文档解析失败：${error.message}` });
        return;
      }
    }
    if (extractedText.trim() && isLikelyGarbledText(extractedText)) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      sendJson(res, 400, { error: '文档文字提取结果仍然存在大量乱码。请将该文件另存为 UTF-8 文本，或转换为清晰 PDF/图片后重新上传。' });
      return;
    }
    if (!extractedText.trim()) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      sendJson(res, 400, { error: '没有从该文档中识别到可用于问答的文字内容。扫描 PDF 或图片请确认画面清晰，并确认 Windows 已安装中文 OCR 语言包。' });
      return;
    }

    const doc = {
      id,
      knowledgeBaseId,
      filename,
      filePath,
      fileType: ext.slice(1),
      fileSize: fileBuffer.length,
      status: usedOcr ? 'AI OCR已处理' : '已上传',
      chunkCount: 0,
      extractedTextLength: extractedText.length,
      extractionMethod: usedOcr ? 'windows-ai-ocr' : 'text-parser',
      createdAt: now,
      updatedAt: now
    };

    db.documents.unshift(doc);
    processDocumentToChunks(db, doc, extractedText);
    refreshKnowledgeBaseStats(db, knowledgeBaseId);
    writeDb(db);
    sendJson(res, 201, doc);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const documentId = decodeURIComponent(deleteMatch[1]);
    const db = readDb();
    const index = db.documents.findIndex(doc => doc.id === documentId);
    if (index === -1) {
      sendJson(res, 404, { error: '文档不存在' });
      return;
    }

    const [doc] = db.documents.splice(index, 1);
    const kb = db.knowledgeBases.find(item => item.id === doc.knowledgeBaseId);
    if (kb) ensureKnowledgeBasePath(kb);
    const filePath = resolveDocumentPath(doc, kb);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    db.chunks = db.chunks.filter(chunk => chunk.documentId !== doc.id);
    refreshKnowledgeBaseStats(db, doc.knowledgeBaseId);
    writeDb(db);
    sendJson(res, 200, { ok: true });
    return;
  }

  const openDocMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/open-location$/);
  if (req.method === 'POST' && openDocMatch) {
    const documentId = decodeURIComponent(openDocMatch[1]);
    const db = readDb();
    const doc = db.documents.find(item => item.id === documentId);
    if (!doc) {
      sendJson(res, 404, { error: '文档不存在' });
      return;
    }
    const kb = db.knowledgeBases.find(item => item.id === doc.knowledgeBaseId);
    if (kb) ensureKnowledgeBasePath(kb);
    const filePath = resolveDocumentPath(doc, kb);
    if (!filePath || !fs.existsSync(filePath)) {
      sendJson(res, 404, { error: '本地文件不存在，无法打开所在位置' });
      return;
    }
    writeDb(db);
    await openInExplorer(filePath, true);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'API not found' });
}

// REGION: Server Startup
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`知枢 AI 知识库平台已启动：http://localhost:${PORT}`);
});










