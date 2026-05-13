const { parentPort, workerData } = require('worker_threads');

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const value of Object.values(a)) aNorm += value * value;
  for (const value of Object.values(b || {})) bNorm += value * value;
  for (const [token, value] of Object.entries(a)) {
    dot += value * ((b && b[token]) || 0);
  }
  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

const { chunks, questionVector, topK } = workerData;
const hits = chunks
  .map(chunk => ({
    ...chunk,
    score: cosineSimilarity(questionVector, chunk.vector || {})
  }))
  .filter(chunk => chunk.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, topK);

parentPort.postMessage(hits);
