package com.zhishu;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class RagEngine {
  private RagEngine() {}

  static String cleanDisplayText(Object value) {
    return String.valueOf(value == null ? "" : value)
      .replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]", " ")
      .replaceAll("[ \\t]+", " ")
      .replaceAll("\\s*[|｜]+\\s*", " | ")
      .replaceAll("\\s*[—–-]{2,}\\s*", " - ")
      .replaceAll("\\s*[└├│┬┴┐┘┌─]+\\s*", " ")
      .replaceAll("([\\u3400-\\u9fff])\\s+(?=[\\u3400-\\u9fff])", "$1")
      .replaceAll("([\\u3400-\\u9fff])\\s+([，。！？；：、”’）】》])", "$1$2")
      .replaceAll("([（【《“‘])\\s+([\\u3400-\\u9fff])", "$1$2")
      .replaceAll("\\n{3,}", "\n\n")
      .trim();
  }

  static List<String> tokenize(String text) {
    String normalized = String.valueOf(text == null ? "" : text).toLowerCase(Locale.ROOT);
    List<String> tokens = new ArrayList<>();
    Matcher matcher = Pattern.compile("[a-z0-9]+|[\\u4e00-\\u9fff]").matcher(normalized);
    List<String> chinese = new ArrayList<>();
    while (matcher.find()) {
      String token = matcher.group();
      tokens.add(token);
      if (token.matches("[\\u4e00-\\u9fff]")) chinese.add(token);
    }
    for (int i = 0; i < chinese.size() - 1; i++) tokens.add(chinese.get(i) + chinese.get(i + 1));
    tokens.removeIf(String::isBlank);
    return tokens;
  }

  static Map<String, Object> vectorizeText(String text) {
    Map<String, Object> vector = new LinkedHashMap<>();
    for (String token : tokenize(text)) {
      vector.put(token, number(vector.get(token)) + 1);
    }
    return vector;
  }

  static double cosineSimilarity(Map<String, Object> a, Map<String, Object> b) {
    double dot = 0;
    double aNorm = 0;
    double bNorm = 0;
    for (Object value : a.values()) aNorm += number(value) * number(value);
    for (Object value : b.values()) bNorm += number(value) * number(value);
    for (Map.Entry<String, Object> entry : a.entrySet()) {
      dot += number(entry.getValue()) * number(b.get(entry.getKey()));
    }
    if (aNorm == 0 || bNorm == 0) return 0;
    return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
  }

  static List<String> chunkText(String text, int size, int overlap) {
    String clean = String.valueOf(text == null ? "" : text).replace("\r\n", "\n").trim();
    List<String> chunks = new ArrayList<>();
    for (int start = 0; start < clean.length(); start += size - overlap) {
      String content = clean.substring(start, Math.min(clean.length(), start + size)).trim();
      if (!content.isEmpty()) chunks.add(content);
    }
    return chunks;
  }

  static List<Map<String, Object>> retrieveChunks(Map<String, Object> db, String knowledgeBaseId, String question, int topK, Set<String> documentIds) {
    Map<String, Object> questionVector = vectorizeText(question);
    List<String> queryTokens = tokenize(question);
    Map<String, Map<String, Object>> docMap = new HashMap<>();
    for (Object item : App.list(db, "documents")) {
      Map<String, Object> doc = App.asMap(item);
      docMap.put(App.s(doc.get("id")), doc);
    }

    List<Map<String, Object>> candidates = new ArrayList<>();
    Map<String, Integer> df = new HashMap<>();
    int totalTokenCount = 0;
    for (Object item : App.list(db, "chunks")) {
      Map<String, Object> chunk = App.asMap(item);
      if (!knowledgeBaseId.equals(App.s(chunk.get("knowledgeBaseId")))) continue;
      if (!documentIds.isEmpty() && !documentIds.contains(App.s(chunk.get("documentId")))) continue;
      List<String> tokens = tokenize(App.s(chunk.get("content")));
      totalTokenCount += Math.max(1, tokens.size());
      Set<String> unique = new HashSet<>(tokens);
      for (String token : new HashSet<>(queryTokens)) if (unique.contains(token)) df.put(token, df.getOrDefault(token, 0) + 1);
      chunk.put("_ragTokens", tokens);
      candidates.add(chunk);
    }

    int n = Math.max(1, candidates.size());
    double avgDocLen = candidates.isEmpty() ? 1.0 : totalTokenCount / (double) candidates.size();
    List<Map<String, Object>> hits = new ArrayList<>();
    for (Map<String, Object> chunk : candidates) {
      Map<String, Object> vector = App.asMap(chunk.get("vector"));
      if (vector.isEmpty()) {
        vector = vectorizeText(App.s(chunk.get("content")));
        chunk.put("vector", vector);
      }
      double cosine = cosineSimilarity(questionVector, vector);
      double bm25 = bm25Score(queryTokens, (List<String>) chunk.get("_ragTokens"), df, n, avgDocLen);
      double bm25Normalized = bm25 / (bm25 + 8.0);
      double titleBoost = App.s(chunk.get("filename")).toLowerCase(Locale.ROOT).contains(String.valueOf(question).toLowerCase(Locale.ROOT)) ? 0.05 : 0;
      double score = (cosine * 0.62) + (bm25Normalized * 0.38) + titleBoost;
      if (score <= 0) continue;
      Map<String, Object> hit = new LinkedHashMap<>(chunk);
      Map<String, Object> doc = docMap.get(App.s(chunk.get("documentId")));
      hit.put("fileType", App.s(chunk.get("fileType")).isBlank() && doc != null ? doc.get("fileType") : chunk.get("fileType"));
      hit.put("score", score);
      hit.remove("_ragTokens");
      hits.add(hit);
    }
    hits.sort((a, b) -> Double.compare(number(b.get("score")), number(a.get("score"))));
    return hits.size() > topK ? new ArrayList<>(hits.subList(0, topK)) : hits;
  }

  static double bm25Score(List<String> queryTokens, List<String> docTokens, Map<String, Integer> df, int n, double avgDocLen) {
    if (queryTokens.isEmpty() || docTokens == null || docTokens.isEmpty()) return 0;
    Map<String, Integer> tf = new HashMap<>();
    for (String token : docTokens) tf.put(token, tf.getOrDefault(token, 0) + 1);
    double k1 = 1.5;
    double b = 0.75;
    double score = 0;
    for (String token : new HashSet<>(queryTokens)) {
      int freq = tf.getOrDefault(token, 0);
      if (freq == 0) continue;
      int docFreq = Math.max(0, df.getOrDefault(token, 0));
      double idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      double denom = freq + k1 * (1 - b + b * (docTokens.size() / avgDocLen));
      score += idf * (freq * (k1 + 1)) / denom;
    }
    return score;
  }

  static List<Map<String, Object>> representativeChunks(Map<String, Object> db, String knowledgeBaseId, Set<String> documentIds, int maxPerDocument) {
    List<Map<String, Object>> selected = new ArrayList<>();
    for (Object docItem : App.list(db, "documents")) {
      Map<String, Object> doc = App.asMap(docItem);
      if (!knowledgeBaseId.equals(App.s(doc.get("knowledgeBaseId")))) continue;
      if (!documentIds.isEmpty() && !documentIds.contains(App.s(doc.get("id")))) continue;
      List<Map<String, Object>> chunks = new ArrayList<>();
      for (Object chunkItem : App.list(db, "chunks")) {
        Map<String, Object> chunk = App.asMap(chunkItem);
        if (App.s(doc.get("id")).equals(App.s(chunk.get("documentId")))) chunks.add(chunk);
      }
      chunks.sort(Comparator.comparingInt(c -> (int) number(c.get("chunkIndex"))));
      if (chunks.isEmpty()) continue;
      Set<Integer> indexes = new TreeSet<>();
      for (int i = 0; i < Math.min(5, chunks.size()); i++) indexes.add(i);
      for (int i = Math.max(0, chunks.size() - 3); i < chunks.size(); i++) indexes.add(i);
      int middleCount = Math.max(0, maxPerDocument - indexes.size());
      for (int i = 1; i <= middleCount; i++) indexes.add((int) Math.floor((chunks.size() - 1) * (i / (double) (middleCount + 1))));
      for (int index : indexes) {
        Map<String, Object> hit = new LinkedHashMap<>(chunks.get(index));
        hit.put("fileType", App.s(hit.get("fileType")).isBlank() ? doc.get("fileType") : hit.get("fileType"));
        hit.put("score", number(hit.get("score")) == 0 ? 0.01 : number(hit.get("score")));
        hit.put("representative", true);
        selected.add(hit);
      }
    }
    return selected;
  }

  static List<Map<String, Object>> selectDiverseHits(List<Map<String, Object>> hits, int limit) {
    List<Map<String, Object>> selected = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    for (Map<String, Object> hit : hits) {
      String key = App.s(hit.get("documentId")) + ":" + App.s(hit.get("chunkIndex"));
      if (!seen.add(key)) continue;
      selected.add(hit);
      if (selected.size() >= limit) break;
    }
    return selected;
  }

  static List<Map<String, Object>> mergeContextHits(List<Map<String, Object>> primary, List<Map<String, Object>> extra, int limit) {
    List<Map<String, Object>> selected = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    List<Map<String, Object>> all = new ArrayList<>();
    all.addAll(primary);
    all.addAll(extra);
    for (Map<String, Object> hit : all) {
      String key = App.s(hit.get("id"));
      if (key.isBlank()) key = App.s(hit.get("documentId")) + ":" + App.s(hit.get("chunkIndex"));
      if (!seen.add(key)) continue;
      selected.add(hit);
      if (selected.size() >= limit) break;
    }
    return selected;
  }

  static String buildContextFromHits(List<Map<String, Object>> hits, int maxChars) {
    int used = 0;
    List<String> blocks = new ArrayList<>();
    for (int i = 0; i < hits.size(); i++) {
      Map<String, Object> hit = hits.get(i);
      int remain = maxChars - used;
      if (remain <= 0) break;
      String content = cleanDisplayText(hit.get("content")).substring(0, Math.min(cleanDisplayText(hit.get("content")).length(), Math.min(1200, remain)));
      String block = String.join("\n",
        "引用 " + (i + 1),
        "文档：" + App.s(hit.get("filename")),
        "片段：" + App.s(hit.get("chunkIndex")),
        "类型：" + (Boolean.TRUE.equals(hit.get("representative")) ? "文档代表片段" : "相关片段"),
        "内容：" + content
      );
      blocks.add(block);
      used += block.length();
    }
    return String.join("\n\n", blocks);
  }

  static List<Object> buildChatMessages(Map<String, Object> kb, String context, String question, String modeNote, boolean fastMode) {
    return List.of(
      App.map("role", "system", "content", String.join("\n",
        "你是知枢 AI 知识库平台的专业问答助手。",
        "你必须先理解用户问题，再基于给出的资料组织答案。",
        "不要机械复读 chunk，不要逐条堆砌片段。",
        "不要输出乱码、奇怪符号、候选编号、JSON、内部检索字段或多余说明。",
        "回答格式必须清晰：优先用短段落；需要列举时使用 1. 2. 3.。",
        "如果资料足以回答，就用自然、完整、人性化的语言回答。",
        "如果资料不足，要明确说明缺少哪些信息。",
        "涉及剧情、情节、证据、出处、对比、原因、结论时，要让答案能被资料依据支撑。",
        fastMode ? "当前是快速模式：请直接回答核心结论，保证格式干净，不要为了快而输出半句或杂乱内容。" : "当前是思考模式：请完整分析，结构清楚，结论充分。"
      )),
      App.map("role", "user", "content", String.join("\n",
        "知识库：" + App.s(kb.get("name")),
        modeNote,
        "",
        "下面是系统检索出的资料片段。请基于这些资料回答问题：",
        "",
        context,
        "",
        "用户问题：" + question,
        "",
        "回答要求：",
        "1. 不要直接照抄 chunk。",
        "2. 先总结判断，再解释原因。",
        "3. 需要引用依据的问题，要在答案中体现资料支撑。",
        "4. 语气自然，像真实助手，不要像模板。",
        fastMode ? "5. 快速模式请控制篇幅，但必须保持完整句子和清晰格式。" : "5. 思考模式请尽量覆盖问题涉及的关键点。"
      ))
    );
  }

  static List<Object> buildChatMessages(Map<String, Object> kb, String context, String question, String modeNote) {
    return buildChatMessages(kb, context, question, modeNote, false);
  }

  static boolean shouldShowRelevance(String question) {
    return Pattern.compile("相关度|相似度|引用|来源|依据|证据|命中|检索|chunk|片段|为什么", Pattern.CASE_INSENSITIVE)
      .matcher(String.valueOf(question == null ? "" : question)).find();
  }

  static boolean shouldShowCitations(String question) {
    return Pattern.compile("引用|来源|原文|依据|证据|哪里|位置|出处|片段|chunk|第几|章节|段落|证明|小说|剧情|情节|高潮|转折|冲突|对话|描写|人物|角色|名场面|关键情节", Pattern.CASE_INSENSITIVE)
      .matcher(String.valueOf(question == null ? "" : question)).find();
  }

  static boolean shouldForceVisualCitations(List<Map<String, Object>> hits) {
    return hits.stream().anyMatch(hit -> List.of("image", "table", "pdf").contains(citationSourceKind(App.s(hit.get("fileType")))));
  }

  static List<Object> quickCitations(List<Map<String, Object>> hits) {
    List<Object> out = new ArrayList<>();
    for (int i = 0; i < Math.min(4, hits.size()); i++) {
      Map<String, Object> hit = hits.get(i);
      String keyText = conciseEvidenceText(hit);
      out.add(App.map(
        "id", hit.get("id"),
        "documentId", hit.get("documentId"),
        "filename", hit.get("filename"),
        "fileType", hit.get("fileType"),
        "chunkIndex", hit.get("chunkIndex"),
        "score", round4(number(hit.get("score"))),
        "content", keyText,
        "keyText", keyText,
        "reason", "快速模式直接采用本地检索命中的高相关片段。"
      ));
    }
    return out;
  }

  static List<Object> analyzeCitationSnippets(String question, String answer, List<Map<String, Object>> hits) {
    // 与 Node 原项目当前行为保持一致：本地选择前 10 个候选中的高相关片段。
    return quickCitations(hits.subList(0, Math.min(10, hits.size())));
  }

  static String conciseEvidenceText(Map<String, Object> hit) {
    String text = cleanDisplayText(hit.get("content")).replaceAll("\\s+", " ").trim();
    if (text.length() <= 220) return text;
    List<String> sentences = new ArrayList<>();
    Matcher matcher = Pattern.compile("[^。！？.!?；;]{12,}[。！？.!?；;]?").matcher(text);
    while (matcher.find()) {
      String sentence = matcher.group().trim();
      if (sentence.length() >= 20) sentences.add(sentence);
      if (sentences.size() >= 2) break;
    }
    if (!sentences.isEmpty()) return left(String.join("", sentences), 220);
    return left(text, 220);
  }

  static List<Object> enrichCitationText(List<Object> citations, Map<String, Object> db) {
    List<Object> out = new ArrayList<>();
    for (Object item : citations) {
      Map<String, Object> citation = new LinkedHashMap<>(App.asMap(item));
      Map<String, Object> doc = App.byId(App.list(db, "documents"), App.s(citation.get("documentId")));
      String fileType = App.s(citation.get("fileType")).isBlank() && doc != null ? App.s(doc.get("fileType")) : App.s(citation.get("fileType"));
      String sourceKind = citationSourceKind(fileType);
      citation.put("fileType", fileType);
      citation.put("sourceKind", sourceKind);
      citation.putIfAbsent("keyText", citation.get("content"));
      citation.putIfAbsent("reason", sourceKind.equals("text") ? "This text supports the answer." : "This content was extracted from a non-plain-text document.");
      out.add(citation);
    }
    return out;
  }

  static String citationSourceKind(String fileType) {
    String type = String.valueOf(fileType == null ? "" : fileType).replace(".", "").toLowerCase(Locale.ROOT);
    if (List.of("png", "jpg", "jpeg", "bmp", "tif", "tiff").contains(type)) return "image";
    if (List.of("csv", "xls", "xlsx").contains(type)) return "table";
    if (type.equals("pdf")) return "pdf";
    return "text";
  }

  static String normalizeExtractedText(String text) {
    return cleanDisplayText(text);
  }

  private static String left(String text, int limit) {
    return text.length() <= limit ? text : text.substring(0, limit);
  }

  private static double round4(double value) {
    return Math.round(value * 10000.0) / 10000.0;
  }

  private static double number(Object value) {
    if (value instanceof Number n) return n.doubleValue();
    try {
      return Double.parseDouble(String.valueOf(value));
    } catch (Exception e) {
      return 0;
    }
  }
}
