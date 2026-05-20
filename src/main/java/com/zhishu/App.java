package com.zhishu;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.apache.tika.Tika;

public class App {
  static final Path ROOT = Paths.get(System.getProperty("user.dir"));
  static final Path PUBLIC_DIR = ROOT.resolve("public");
  static final Path DATA_DIR = ROOT.resolve("data");
  static final Path DB_PATH = DATA_DIR.resolve("db.json");
  static final Path SQLITE_PATH = DATA_DIR.resolve("app.db");
  static final Path KB_DIR = DATA_DIR.resolve("knowledge-bases");
  static final Path LOG_EXPORT_DIR = DATA_DIR.resolve("exported-logs");
  static final HttpClient HTTP = HttpClient.newHttpClient();
  static final Tika TIKA = new Tika();
  static final ExecutorService DOC_WORKERS = Executors.newFixedThreadPool(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())));
  static final Map<String, String> DOTENV = loadEnv();
  static final List<String> AVATARS = List.of("wolf", "fox", "cat", "dog", "bear", "rabbit", "panda", "tiger", "lion", "deer", "raccoon", "otter", "hamster", "koala", "red-panda", "squirrel", "owl", "penguin", "seal", "dragon");
  static Object cachedDb;
  static long cachedMtime = -1;

  public static void main(String[] args) throws Exception {
    Files.createDirectories(DATA_DIR);
    Files.createDirectories(KB_DIR);
    Files.createDirectories(LOG_EXPORT_DIR);
    initSqlite();
    TIKA.setMaxStringLength(-1);
    int port = Integer.parseInt(env("PORT", "3001"));
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/api/", App::apiSafe);
    server.createContext("/", App::staticSafe);
    server.setExecutor(Executors.newFixedThreadPool(Math.max(8, Runtime.getRuntime().availableProcessors() * 2)));
    server.start();
    System.out.println("Zhishu Java backend: http://localhost:" + port);
  }

  static void apiSafe(HttpExchange ex) throws IOException {
    try {
      api(ex);
    } catch (Throwable e) {
      e.printStackTrace();
      json(ex, 500, map("error", e.getMessage() == null ? e.toString() : e.getMessage()));
    }
  }

  static void staticSafe(HttpExchange ex) throws IOException {
    try {
      serveStatic(ex);
    } catch (Throwable e) {
      text(ex, 500, "Server error");
    }
  }

  static void api(HttpExchange ex) throws Exception {
    String method = ex.getRequestMethod();
    String path = ex.getRequestURI().getPath();
    Map<String, String> q = query(ex.getRequestURI());

    if (method.equals("GET") && path.equals("/api/config")) {
      json(ex, 200, map("appMode", "server", "isServerMode", true));
      return;
    }
    if (method.equals("GET") && path.equals("/api/health")) {
      json(ex, 200, map("ok", true, "name", "知枢 AI 知识库平台 Java版"));
      return;
    }
    if (method.equals("GET") && path.equals("/api/auth/avatars")) {
      json(ex, 200, map("items", AVATARS));
      return;
    }
    if (method.equals("POST") && path.equals("/api/select-folder")) {
      json(ex, 400, map("error", "Java server mode does not support selecting local folders"));
      return;
    }

    Map<String, Object> db = db();
    normalize(db);
    Matcher m;

    if (method.equals("POST") && path.equals("/api/auth/register")) { authRegister(ex, db, body(ex)); return; }
    if (method.equals("POST") && path.equals("/api/auth/login")) { authLogin(ex, db, body(ex)); return; }
    if (method.equals("GET") && path.equals("/api/auth/user")) { authUser(ex, db, q.get("id")); return; }
    if (method.equals("POST") && path.equals("/api/auth/change-password")) { changePassword(ex, db, body(ex)); return; }
    if (method.equals("POST") && path.equals("/api/auth/preferences")) { preferences(ex, db, body(ex)); return; }
    if (method.equals("GET") && path.equals("/api/admin/users")) { adminUsers(ex, db, q.get("userId")); return; }
    if (method.equals("POST") && path.equals("/api/admin/reset-password")) { resetPassword(ex, db, body(ex)); return; }

    if (method.equals("GET") && path.equals("/api/knowledge-bases")) { kbList(ex, db, user(ex, db, q.get("userId"))); return; }
    if (method.equals("POST") && path.equals("/api/knowledge-bases")) { kbCreate(ex, db, body(ex)); return; }
    if ((m = match(path, "^/api/knowledge-bases/([^/]+)/sharing$")) != null && method.equals("PATCH")) { kbSharing(ex, db, dec(m.group(1)), body(ex)); return; }
    if ((m = match(path, "^/api/knowledge-bases/([^/]+)/open-folder$")) != null && method.equals("POST")) { json(ex, 400, map("error", "Server mode does not support opening server folders")); return; }
    if ((m = match(path, "^/api/knowledge-bases/([^/]+)$")) != null && method.equals("DELETE")) { kbDelete(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }

    if (method.equals("GET") && path.equals("/api/groups")) { groups(ex, db, user(ex, db, q.get("userId"))); return; }
    if (method.equals("GET") && path.equals("/api/groups/search")) { groupSearch(ex, db, user(ex, db, q.get("userId")), q.getOrDefault("q", "")); return; }
    if (method.equals("POST") && path.equals("/api/groups")) { groupCreate(ex, db, body(ex)); return; }
    if ((m = match(path, "^/api/groups/([^/]+)$")) != null && method.equals("PATCH")) { groupPatch(ex, db, dec(m.group(1)), body(ex)); return; }
    if ((m = match(path, "^/api/groups/([^/]+)$")) != null && method.equals("DELETE")) { groupDelete(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/knowledge-bases$")) != null && method.equals("GET")) { groupKbs(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/members$")) != null && method.equals("GET")) { groupMembers(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/members/([^/]+)$")) != null && method.equals("PATCH")) { groupRole(ex, db, dec(m.group(1)), dec(m.group(2)), body(ex)); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/members/([^/]+)$")) != null && method.equals("DELETE")) { groupRemove(ex, db, dec(m.group(1)), dec(m.group(2)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/join-requests$")) != null && method.equals("POST")) { joinRequest(ex, db, dec(m.group(1)), body(ex)); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/join-requests$")) != null && method.equals("GET")) { joinRequests(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/groups/([^/]+)/join-requests/([^/]+)/review$")) != null && method.equals("POST")) { joinReview(ex, db, dec(m.group(1)), dec(m.group(2)), body(ex)); return; }

    if (method.equals("GET") && path.equals("/api/documents")) { docs(ex, db, user(ex, db, q.get("userId")), q.get("knowledgeBaseId")); return; }
    if (method.equals("POST") && path.equals("/api/documents")) { docUpload(ex, db, body(ex)); return; }
    if ((m = match(path, "^/api/documents/([^/]+)/download$")) != null && method.equals("GET")) { docDownload(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/documents/([^/]+)/open-location$")) != null && method.equals("POST")) { json(ex, 400, map("error", "Server mode does not support opening server folders")); return; }
    if ((m = match(path, "^/api/documents/([^/]+)$")) != null && method.equals("DELETE")) { docDelete(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }

    if (method.equals("GET") && path.equals("/api/chat-history")) { chatHistory(ex, db, user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/chat-history/([^/]+)$")) != null && method.equals("GET")) { chatOne(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/chat-history/([^/]+)$")) != null && method.equals("DELETE")) { chatDelete(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if (method.equals("POST") && path.equals("/api/chat")) { chat(ex, db, body(ex)); return; }
    if (method.equals("POST") && path.equals("/api/chat-stream")) { chatStream(ex, db, body(ex)); return; }

    if (method.equals("GET") && path.equals("/api/logs")) { logs(ex, db, user(ex, db, q.get("userId"))); return; }
    if (method.equals("POST") && path.equals("/api/logs/export")) { logsExport(ex, db, body(ex)); return; }
    if ((m = match(path, "^/api/logs/([^/]+)/download$")) != null && method.equals("GET")) { logDownload(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/logs/([^/]+)/open-location$")) != null && method.equals("POST")) { json(ex, 400, map("error", "Server mode does not support opening server folders")); return; }
    if ((m = match(path, "^/api/logs/([^/]+)$")) != null && method.equals("GET")) { logOne(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }
    if ((m = match(path, "^/api/logs/([^/]+)$")) != null && method.equals("DELETE")) { logDelete(ex, db, dec(m.group(1)), user(ex, db, q.get("userId"))); return; }

    json(ex, 404, map("error", "API not found"));
  }

  static void authRegister(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    String username = s(b.get("username")).trim();
    String password = s(b.get("password"));
    String role = "admin".equals(s(b.get("role"))) ? "admin" : "user";
    String userType = "enterprise".equals(s(b.get("userType"))) ? "enterprise" : "personal";
    if (role.equals("admin")) userType = "enterprise";
    if (username.isEmpty() || password.isEmpty()) { json(ex, 400, map("error", "用户名和密码不能为空")); return; }
    if (!password.equals(s(b.get("passwordConfirm")))) { json(ex, 400, map("error", "两次密码不一致")); return; }
    if (!strongPassword(password)) { json(ex, 400, map("error", "密码强度不足：至少 8 位，并且必须同时包含英文字母和数字")); return; }
    if (role.equals("admin") && !env("ADMIN_REGISTER_KEY", "chuanchuancute").equals(s(b.get("adminKey")))) { json(ex, 400, map("error", "管理员密钥错误")); return; }
    for (Object item : list(db, "users")) if (username.equals(s(asMap(item).get("username")))) { json(ex, 409, map("error", "用户名已存在")); return; }
    String salt = id("salt");
    String now = now();
    Map<String, Object> user = map("id", id("user"), "username", username, "role", role, "userType", userType, "salt", salt, "passwordHash", sha(password + salt), "avatarId", avatar(s(b.get("avatarId"))), "brandAvatarId", "wolf", "busyAvatarId", "wolf", "aiAvatarId", "wolf", "createdAt", now, "updatedAt", now);
    list(db, "users").add(0, user);
    save(db);
    json(ex, 201, map("user", publicUser(user)));
  }
  static void authLogin(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = null;
    for (Object item : list(db, "users")) if (s(b.get("username")).trim().equals(s(asMap(item).get("username")))) user = asMap(item);
    if (user == null || !verify(s(b.get("password")), user)) { json(ex, 401, map("error", "用户名或密码错误")); return; }
    json(ex, 200, map("user", publicUser(user)));
  }

  static void authUser(HttpExchange ex, Map<String, Object> db, String id) throws IOException {
    Map<String, Object> user = byId(list(db, "users"), id);
    if (user == null) json(ex, 404, map("error", "User not found"));
    else json(ex, 200, map("user", publicUser(user)));
  }

  static void changePassword(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = byId(list(db, "users"), s(b.get("userId")));
    if (user == null) { json(ex, 404, map("error", "User not found")); return; }
    if (!verify(s(b.get("oldPassword")), user)) { json(ex, 400, map("error", "Old password is incorrect")); return; }
    String next = s(b.get("newPassword"));
    if (next.isEmpty() || !next.equals(s(b.get("newPasswordConfirm")))) { json(ex, 400, map("error", "New password is empty or not confirmed")); return; }
    if (!strongPassword(next)) { json(ex, 400, map("error", "密码强度不足：至少 8 位，并且必须同时包含英文字母和数字")); return; }
    String salt = id("salt");
    user.put("salt", salt);
    user.put("passwordHash", sha(next + salt));
    user.put("updatedAt", now());
    save(db);
    json(ex, 200, map("user", publicUser(user)));
  }

  static void preferences(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = byId(list(db, "users"), s(b.get("userId")));
    if (user == null) { json(ex, 404, map("error", "User not found")); return; }
    for (String key : List.of("avatarId", "brandAvatarId", "busyAvatarId", "aiAvatarId")) user.put(key, avatar(s(b.getOrDefault(key, user.getOrDefault(key, "wolf")))));
    user.put("updatedAt", now());
    save(db);
    json(ex, 200, map("user", publicUser(user)));
  }

  static void adminUsers(HttpExchange ex, Map<String, Object> db, String adminId) throws IOException {
    Map<String, Object> admin = byId(list(db, "users"), adminId);
    if (admin == null || !"admin".equals(s(admin.get("role")))) { json(ex, 403, map("error", "Only admins can view users")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "users")) {
      Map<String, Object> user = asMap(item);
      items.add(map("id", user.get("id"), "username", user.get("username"), "role", user.get("role"), "userType", user.getOrDefault("userType", "admin".equals(s(user.get("role"))) ? "enterprise" : "personal"), "avatarId", user.getOrDefault("avatarId", "wolf"), "createdAt", user.get("createdAt"), "updatedAt", user.get("updatedAt"), "password", "密码已加密保存，无法查看原文"));
    }
    json(ex, 200, map("items", items));
  }

  static void resetPassword(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> admin = byId(list(db, "users"), s(b.get("adminId")));
    if (admin == null || !"admin".equals(s(admin.get("role")))) { json(ex, 403, map("error", "Only admins can reset passwords")); return; }
    Map<String, Object> target = byId(list(db, "users"), s(b.get("targetUserId")));
    if (target == null) { json(ex, 404, map("error", "Target user not found")); return; }
    String next = s(b.get("newPassword"));
    if (next.isEmpty() || !next.equals(s(b.get("newPasswordConfirm")))) { json(ex, 400, map("error", "New password is empty or not confirmed")); return; }
    if (!strongPassword(next)) { json(ex, 400, map("error", "密码强度不足：至少 8 位，并且必须同时包含英文字母和数字")); return; }
    String salt = id("salt");
    target.put("salt", salt);
    target.put("passwordHash", sha(next + salt));
    target.put("updatedAt", now());
    save(db);
    json(ex, 200, map("ok", true, "user", publicUser(target)));
  }

  static void kbList(HttpExchange ex, Map<String, Object> db, Map<String, Object> user) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "knowledgeBases")) {
      Map<String, Object> kb = asMap(item);
      ensureKb(kb);
      kb.put("documentCount", docsOf(db, s(kb.get("id"))).size());
      if (canRead(db, user, kb)) items.add(serializeKb(db, user, kb));
    }
    save(db);
    json(ex, 200, map("items", items));
  }

  static void kbCreate(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    String name = s(b.get("name")).trim();
    if (name.isEmpty()) { json(ex, 400, map("error", "Knowledge base name is required")); return; }
    String kid = id("kb");
    Path folder = KB_DIR.resolve(safeName(name) + "_" + kid);
    Files.createDirectories(folder);
    String now = now();
    Map<String, Object> kb = map("id", kid, "name", name, "description", s(b.get("description")).trim(), "useDefaultPath", true, "folderPath", folder.toString(), "documentCount", 0, "ownerUserId", user.get("id"), "visibility", "private", "createdAt", now, "updatedAt", now);
    list(db, "knowledgeBases").add(0, kb);
    save(db);
    json(ex, 201, serializeKb(db, user, kb));
  }

  static void kbDelete(HttpExchange ex, Map<String, Object> db, String kbId, Map<String, Object> user) throws IOException {
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), kbId);
    if (user == null || kb == null || !canManageKb(user, kb)) { json(ex, 403, map("error", "Only the knowledge base owner can delete it")); return; }
    removeId(list(db, "knowledgeBases"), kbId);
    list(db, "documents").removeIf(x -> kbId.equals(s(asMap(x).get("knowledgeBaseId"))));
    list(db, "chunks").removeIf(x -> kbId.equals(s(asMap(x).get("knowledgeBaseId"))));
    list(db, "knowledgeBaseShares").removeIf(x -> kbId.equals(s(asMap(x).get("knowledgeBaseId"))));
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void kbSharing(HttpExchange ex, Map<String, Object> db, String kbId, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), kbId);
    if (user == null || kb == null || !canManageKb(user, kb)) { json(ex, 403, map("error", "Only owner can change sharing")); return; }
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    Set<String> joined = joinedGroups(db, s(user.get("id")));
    List<Object> groupIds = b.get("groupIds") instanceof List<?> list ? new ArrayList<>(list) : new ArrayList<>();
    list(db, "knowledgeBaseShares").removeIf(x -> kbId.equals(s(asMap(x).get("knowledgeBaseId"))));
    for (Object groupId : groupIds) {
      String gid = s(groupId);
      if (joined.contains(gid)) list(db, "knowledgeBaseShares").add(map("id", id("kbs"), "knowledgeBaseId", kbId, "groupId", gid, "permission", "read", "createdAt", now()));
    }
    kb.put("visibility", groupIds.isEmpty() ? "private" : "group");
    kb.put("updatedAt", now());
    save(db);
    json(ex, 200, serializeKb(db, user, kb));
  }

  static void docs(HttpExchange ex, Map<String, Object> db, Map<String, Object> user, String kbId) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "documents")) {
      Map<String, Object> doc = asMap(item);
      Map<String, Object> kb = byId(list(db, "knowledgeBases"), s(doc.get("knowledgeBaseId")));
      if (kb != null && canRead(db, user, kb) && (kbId == null || kbId.equals(s(doc.get("knowledgeBaseId"))))) items.add(doc);
    }
    json(ex, 200, map("items", items));
  }

  static void docUpload(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), s(b.get("knowledgeBaseId")));
    if (user == null) { json(ex, 401, map("error", "请先登录")); return; }
    if (kb == null) { json(ex, 404, map("error", "知识库不存在，请刷新知识库列表后重试")); return; }
    if (!canManageKb(user, kb)) { json(ex, 403, map("error", "不能上传到该知识库。你只能上传到自己创建的知识库，用户组共享知识库仅支持查看和问答。")); return; }
    String filename = s(b.get("filename"));
    byte[] bytes = Base64.getDecoder().decode(s(b.get("contentBase64")));
    ensureKb(kb);
    Path file = Paths.get(s(kb.get("folderPath"))).resolve(safeName(filename));
    Files.write(file, bytes);
    String now = now();
    String docId = id("doc");
    Map<String, Object> doc = map("id", docId, "knowledgeBaseId", kb.get("id"), "ownerUserId", user.get("id"), "filename", filename, "filePath", file.toString(), "fileType", ext(filename), "fileSize", bytes.length, "status", "processing", "chunkCount", 0, "processMessage", "文档已上传，正在后台解析", "createdAt", now, "updatedAt", now);
    list(db, "documents").add(0, doc);
    kb.put("updatedAt", now);
    save(db);
    DOC_WORKERS.submit(() -> processDocumentJob(docId));
    json(ex, 202, map("ok", true, "document", doc, "message", "文档上传成功，后台正在解析，完成后可用于问答"));
  }

  static void processDocumentJob(String docId) {
    try {
      Map<String, Object> db = db();
      Map<String, Object> doc = byId(list(db, "documents"), docId);
      if (doc == null) return;
      byte[] bytes = Files.readAllBytes(Paths.get(s(doc.get("filePath"))));
      String content = extractText(s(doc.get("filename")), bytes);
      List<String> chunks = RagEngine.chunkText(RagEngine.normalizeExtractedText(content), 500, 100);
      synchronized (App.class) {
        db = db();
        doc = byId(list(db, "documents"), docId);
        if (doc == null) return;
        list(db, "chunks").removeIf(x -> docId.equals(s(asMap(x).get("documentId"))));
        String now = now();
        for (int i = 0; i < chunks.size(); i++) {
          list(db, "chunks").add(map("id", "chunk_" + docId + "_" + i, "knowledgeBaseId", doc.get("knowledgeBaseId"), "documentId", docId, "fileType", doc.get("fileType"), "filename", doc.get("filename"), "chunkIndex", i + 1, "content", chunks.get(i), "vector", RagEngine.vectorizeText(chunks.get(i)), "sourceKind", sourceKind(s(doc.get("filename"))), "createdAt", now));
        }
        doc.put("status", "ready");
        doc.put("chunkCount", chunks.size());
        doc.put("processMessage", "解析完成");
        doc.put("updatedAt", now);
        save(db);
      }
    } catch (Exception e) {
      try {
        synchronized (App.class) {
          Map<String, Object> db = db();
          Map<String, Object> doc = byId(list(db, "documents"), docId);
          if (doc != null) {
            doc.put("status", "failed");
            doc.put("processMessage", e.getMessage() == null ? e.toString() : e.getMessage());
            doc.put("updatedAt", now());
            save(db);
          }
        }
      } catch (Exception ignored) {}
    }
  }

  static void docDelete(HttpExchange ex, Map<String, Object> db, String docId, Map<String, Object> user) throws IOException {
    Map<String, Object> doc = byId(list(db, "documents"), docId);
    Map<String, Object> kb = doc == null ? null : byId(list(db, "knowledgeBases"), s(doc.get("knowledgeBaseId")));
    if (user == null || kb == null || !canManageKb(user, kb)) { json(ex, 403, map("error", "No permission to delete this document")); return; }
    Files.deleteIfExists(Paths.get(s(doc.get("filePath"))));
    removeId(list(db, "documents"), docId);
    list(db, "chunks").removeIf(x -> docId.equals(s(asMap(x).get("documentId"))));
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void docDownload(HttpExchange ex, Map<String, Object> db, String docId, Map<String, Object> user) throws IOException {
    Map<String, Object> doc = byId(list(db, "documents"), docId);
    if (doc == null) { json(ex, 404, map("error", "Document not found")); return; }
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), s(doc.get("knowledgeBaseId")));
    if (!canRead(db, user, kb)) { json(ex, 403, map("error", "No permission to download this document")); return; }
    download(ex, Paths.get(s(doc.get("filePath"))), s(doc.get("filename")));
  }

  static void chat(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws Exception {
    long start = System.currentTimeMillis();
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    String kbId = s(b.get("knowledgeBaseId"));
    String question = s(b.get("question")).trim();
    String mode = "fast".equals(s(b.get("answerMode"))) ? "fast" : "thinking";
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), kbId);
    if (user == null || kb == null || !canRead(db, user, kb)) { json(ex, 403, map("error", "No permission to use this knowledge base")); return; }
    if (question.isEmpty()) { json(ex, 400, map("error", "问题不能为空")); return; }

    Set<String> docIds = new HashSet<>();
    if (b.get("documentIds") instanceof List<?> ids) for (Object id : ids) docIds.add(s(id));

    boolean fastMode = mode.equals("fast");
    List<Map<String, Object>> searchHits = RagEngine.selectDiverseHits(
      RagEngine.retrieveChunks(db, kbId, question, fastMode ? 12 : 60, docIds),
      fastMode ? 5 : 24
    );
    List<Map<String, Object>> representativeHits = fastMode ? new ArrayList<>() : RagEngine.representativeChunks(db, kbId, docIds, 20);
    List<Map<String, Object>> hits = fastMode ? searchHits : RagEngine.mergeContextHits(searchHits, representativeHits, 36);
    if (hits.isEmpty()) { json(ex, 400, map("error", "No relevant document chunks found")); return; }

    String context = RagEngine.buildContextFromHits(hits, fastMode ? 4200 : 28000);
    List<Object> messages = RagEngine.buildChatMessages(kb, context, question, fastMode
      ? "快速模式：优先基于少量最相关片段快速回答。"
      : "思考模式：系统提供相关片段和文档代表片段。", fastMode);
    String answer = callDeepSeek(messages, mode);
    if (answer.trim().isEmpty()) throw new RuntimeException("AI returned empty content");

    boolean shouldDisplayCitations = RagEngine.shouldShowCitations(question) || RagEngine.shouldForceVisualCitations(hits);
    List<Map<String, Object>> highRelevanceHits = hits.stream().filter(hit -> num(hit.get("score")) >= 0.7).toList();
    List<Map<String, Object>> citationCandidates = highRelevanceHits.isEmpty()
      ? hits.subList(0, Math.min(6, hits.size()))
      : highRelevanceHits;
    List<Object> citationAnalysis = shouldDisplayCitations
      ? analyzeCitationSnippets(question, answer, citationCandidates, false)
      : new ArrayList<>();
    List<Object> citations = RagEngine.enrichCitationText(citationAnalysis, db);

    long latency = System.currentTimeMillis() - start;
    String now = now();
    String citationDecision = shouldDisplayCitations ? (citations.isEmpty() ? "none-high-relevance" : "show") : "ai-summary";
    List<Object> retrievedChunks = new ArrayList<>();
    for (Map<String, Object> hit : hits) {
      retrievedChunks.add(map(
        "id", hit.get("id"),
        "documentId", hit.get("documentId"),
        "filename", hit.get("filename"),
        "chunkIndex", hit.get("chunkIndex"),
        "score", Math.round(num(hit.get("score")) * 10000.0) / 10000.0,
        "content", hit.get("content")
      ));
    }

    Map<String, Object> result = map("answer", answer, "citations", citations, "citationDecision", citationDecision, "showRelevance", RagEngine.shouldShowRelevance(question), "answerMode", mode, "latencyMs", latency);
    String chatId = id("chat");
    list(db, "chatMessages").add(0, map("id", chatId, "ownerUserId", user.get("id"), "knowledgeBaseId", kbId, "knowledgeBaseName", kb.get("name"), "documentIds", new ArrayList<>(docIds), "question", question, "answer", answer, "citations", citations, "citationDecision", citationDecision, "showRelevance", RagEngine.shouldShowRelevance(question), "answerMode", mode, "latencyMs", latency, "model", deepSeekModel(), "createdAt", now));
    list(db, "aiLogs").add(0, map("id", id("log"), "ownerUserId", user.get("id"), "title", question.length() > 40 ? question.substring(0, 40) : question, "chatId", chatId, "knowledgeBaseId", kbId, "knowledgeBaseName", kb.get("name"), "documentIds", new ArrayList<>(docIds), "question", question, "answerMode", mode, "retrievedChunks", retrievedChunks, "citationAnalysis", map("citations", citations, "reasoning", fastMode ? "fast mode citation evidence refined locally" : "AI citation evidence analysis"), "messages", messages, "answer", answer, "reasoning", "", "model", deepSeekModel(), "latencyMs", latency, "createdAt", now, "exported", false, "bucket", bucket(now)));
    save(db);
    json(ex, 200, result);
  }

  static void chatStream(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws Exception {
    long start = System.currentTimeMillis();
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    String kbId = s(b.get("knowledgeBaseId"));
    String question = s(b.get("question")).trim();
    String mode = "fast".equals(s(b.get("answerMode"))) ? "fast" : "thinking";
    Map<String, Object> kb = byId(list(db, "knowledgeBases"), kbId);
    if (user == null || kb == null || !canRead(db, user, kb)) { json(ex, 403, map("error", "No permission to use this knowledge base")); return; }
    if (question.isEmpty()) { json(ex, 400, map("error", "问题不能为空")); return; }

    Set<String> docIds = new HashSet<>();
    if (b.get("documentIds") instanceof List<?> ids) for (Object id : ids) docIds.add(s(id));
    boolean fastMode = mode.equals("fast");
    List<Map<String, Object>> searchHits = RagEngine.selectDiverseHits(RagEngine.retrieveChunks(db, kbId, question, fastMode ? 12 : 60, docIds), fastMode ? 5 : 24);
    List<Map<String, Object>> representativeHits = fastMode ? new ArrayList<>() : RagEngine.representativeChunks(db, kbId, docIds, 20);
    List<Map<String, Object>> hits = fastMode ? searchHits : RagEngine.mergeContextHits(searchHits, representativeHits, 36);
    if (hits.isEmpty()) { json(ex, 400, map("error", "No relevant document chunks found")); return; }

    String context = RagEngine.buildContextFromHits(hits, fastMode ? 4200 : 28000);
    List<Object> messages = RagEngine.buildChatMessages(kb, context, question, fastMode ? "快速模式：优先基于少量最相关片段快速回答。" : "思考模式：系统提供相关片段和文档代表片段。", fastMode);
    Headers h = ex.getResponseHeaders();
    h.set("Content-Type", "text/event-stream; charset=utf-8");
    h.set("Cache-Control", "no-cache");
    h.set("Connection", "keep-alive");
    ex.sendResponseHeaders(200, 0);
    StringBuilder answer = new StringBuilder();
    try (OutputStream out = ex.getResponseBody()) {
      sse(out, "meta", map("answerMode", mode));
      callDeepSeekStream(messages, mode, delta -> {
        answer.append(delta);
        try { sse(out, "delta", map("text", delta)); } catch (IOException e) { throw new RuntimeException(e); }
      });
      Map<String, Object> finalData = finalizeChatRecord(db, user, kb, kbId, docIds, question, mode, fastMode, hits, messages, answer.toString(), start);
      sse(out, "final", finalData);
    }
  }

  static Map<String, Object> finalizeChatRecord(Map<String, Object> db, Map<String, Object> user, Map<String, Object> kb, String kbId, Set<String> docIds, String question, String mode, boolean fastMode, List<Map<String, Object>> hits, List<Object> messages, String answer, long start) throws IOException {
    boolean shouldDisplayCitations = RagEngine.shouldShowCitations(question) || RagEngine.shouldForceVisualCitations(hits);
    List<Map<String, Object>> highRelevanceHits = hits.stream().filter(hit -> num(hit.get("score")) >= 0.7).toList();
    List<Map<String, Object>> citationCandidates = highRelevanceHits.isEmpty() ? hits.subList(0, Math.min(6, hits.size())) : highRelevanceHits;
    List<Object> citationAnalysis = shouldDisplayCitations ? analyzeCitationSnippets(question, answer, citationCandidates, false) : new ArrayList<>();
    List<Object> citations = RagEngine.enrichCitationText(citationAnalysis, db);
    long latency = System.currentTimeMillis() - start;
    String now = now();
    String citationDecision = shouldDisplayCitations ? (citations.isEmpty() ? "none-high-relevance" : "show") : "ai-summary";
    List<Object> retrievedChunks = new ArrayList<>();
    for (Map<String, Object> hit : hits) retrievedChunks.add(map("id", hit.get("id"), "documentId", hit.get("documentId"), "filename", hit.get("filename"), "chunkIndex", hit.get("chunkIndex"), "score", Math.round(num(hit.get("score")) * 10000.0) / 10000.0, "content", hit.get("content")));
    Map<String, Object> result = map("answer", answer, "citations", citations, "citationDecision", citationDecision, "showRelevance", RagEngine.shouldShowRelevance(question), "answerMode", mode, "latencyMs", latency);
    String chatId = id("chat");
    list(db, "chatMessages").add(0, map("id", chatId, "ownerUserId", user.get("id"), "knowledgeBaseId", kbId, "knowledgeBaseName", kb.get("name"), "documentIds", new ArrayList<>(docIds), "question", question, "answer", answer, "citations", citations, "citationDecision", citationDecision, "showRelevance", RagEngine.shouldShowRelevance(question), "answerMode", mode, "latencyMs", latency, "model", deepSeekModel(), "createdAt", now));
    list(db, "aiLogs").add(0, map("id", id("log"), "ownerUserId", user.get("id"), "title", question.length() > 40 ? question.substring(0, 40) : question, "chatId", chatId, "knowledgeBaseId", kbId, "knowledgeBaseName", kb.get("name"), "documentIds", new ArrayList<>(docIds), "question", question, "answerMode", mode, "retrievedChunks", retrievedChunks, "citationAnalysis", map("citations", citations, "reasoning", fastMode ? "fast mode citation evidence refined locally" : "AI citation evidence analysis"), "messages", messages, "answer", answer, "reasoning", "", "model", deepSeekModel(), "latencyMs", latency, "createdAt", now, "exported", false, "bucket", bucket(now)));
    save(db);
    return result;
  }
  static String callDeepSeek(List<Object> messages, String mode) throws Exception {
    String key = env("DEEPSEEK_API_KEY", env("API_KEY", ""));
    if (key.isBlank()) throw new RuntimeException("未配置 DEEPSEEK_API_KEY");
    String base = env("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replaceAll("/$", "");
    String model = deepSeekModel();
    Map<String, Object> reqBody = map("model", model, "messages", messages, "temperature", mode.equals("fast") ? 0.2 : 0.35, "reasoning", map("enabled", !mode.equals("fast")), "stream", false);
    HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
      .timeout(java.time.Duration.ofSeconds(mode.equals("fast") ? 10 : 180))
      .header("Content-Type", "application/json")
      .header("Authorization", "Bearer " + key)
      .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(reqBody), StandardCharsets.UTF_8))
      .build();
    HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    if (resp.statusCode() < 200 || resp.statusCode() >= 300) throw new RuntimeException("DeepSeek 调用失败：" + resp.body());
    Map<String, Object> data = asMap(Json.parse(resp.body()));
    List<Object> choices = list(data, "choices");
    if (choices.isEmpty()) return "AI 未返回内容";
    return s(asMap(asMap(choices.get(0)).get("message")).get("content"));
  }

  interface DeltaConsumer { void accept(String delta); }

  static void callDeepSeekStream(List<Object> messages, String mode, DeltaConsumer consumer) throws Exception {
    String key = env("DEEPSEEK_API_KEY", env("API_KEY", ""));
    if (key.isBlank()) throw new RuntimeException("未配置 DEEPSEEK_API_KEY");
    String base = env("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replaceAll("/$", "");
    String model = deepSeekModel();
    Map<String, Object> reqBody = map("model", model, "messages", messages, "temperature", 0.35, "stream", true);
    HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/chat/completions"))
      .header("Content-Type", "application/json")
      .header("Authorization", "Bearer " + key)
      .POST(HttpRequest.BodyPublishers.ofString(Json.stringify(reqBody), StandardCharsets.UTF_8))
      .build();
    HttpResponse<java.io.InputStream> res = HTTP.send(req, HttpResponse.BodyHandlers.ofInputStream());
    if (res.statusCode() >= 400) {
      String error = new String(res.body().readAllBytes(), StandardCharsets.UTF_8);
      throw new RuntimeException("DeepSeek 调用失败：" + error);
    }
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(res.body(), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        line = line.trim();
        if (!line.startsWith("data:")) continue;
        String data = line.substring(5).trim();
        if ("[DONE]".equals(data)) break;
        Map<String, Object> parsed = asMap(Json.parse(data));
        List<Object> choices = list(parsed, "choices");
        if (choices.isEmpty()) continue;
        Map<String, Object> delta = asMap(asMap(choices.get(0)).get("delta"));
        String text = s(delta.get("content"));
        if (!text.isEmpty()) consumer.accept(text);
      }
    }
  }

  static void sse(OutputStream out, String event, Object data) throws IOException {
    out.write(("event: " + event + "\n").getBytes(StandardCharsets.UTF_8));
    out.write(("data: " + Json.stringify(data).replace("\n", "\\n") + "\n\n").getBytes(StandardCharsets.UTF_8));
    out.flush();
  }

  static List<Object> analyzeCitationSnippets(String question, String answer, List<Map<String, Object>> hits, boolean fastMode) {
    if (hits.isEmpty()) return new ArrayList<>();
    if (fastMode) return RagEngine.quickCitations(hits);
    try {
      List<Object> candidates = new ArrayList<>();
      for (int i = 0; i < Math.min(10, hits.size()); i++) {
        Map<String, Object> hit = hits.get(i);
        candidates.add(map(
          "candidateId", i + 1,
          "documentId", hit.get("documentId"),
          "filename", hit.get("filename"),
          "fileType", hit.get("fileType"),
          "chunkIndex", hit.get("chunkIndex"),
          "score", Math.round(num(hit.get("score")) * 10000.0) / 10000.0,
          "content", left(RagEngine.cleanDisplayText(hit.get("content")), 900)
        ));
      }
      List<Object> messages = List.of(
        map("role", "system", "content", String.join("\n",
          "你是 RAG 引用依据分析器。",
          "你的任务不是复述 chunk，而是判断哪些候选片段真正支撑 AI 回答。",
          "你必须从候选片段中提炼连贯、可读、短小的资料依据。",
          "不要截取半句话，不要保留目录树乱码、无意义空格、断裂符号。",
          "如果原片段很碎，要用忠于原意的方式整理成一句完整依据。",
          "只返回 JSON 数组，不要输出解释，不要 Markdown。"
        )),
        map("role", "user", "content", String.join("\n",
          "用户问题：",
          question,
          "",
          "AI 回答：",
          answer,
          "",
          "候选片段 JSON：",
          Json.stringify(candidates),
          "",
          "请返回最多 6 条引用依据，每条格式：",
          "[{\"candidateId\":1,\"keyText\":\"完整、连贯、可读的依据文字，80-220字\",\"reason\":\"说明这条依据支撑了回答中的哪一点\"}]",
          "要求：keyText 必须来自候选片段的信息，不要编造；但可以清洗空格、修复断句、合并碎片。"
        ))
      );
      String raw = callDeepSeek(messages, "fast");
      List<Object> parsed = parseJsonArray(raw);
      List<Object> out = new ArrayList<>();
      for (Object item : parsed) {
        Map<String, Object> row = asMap(item);
        int candidateIndex = Math.max(1, (int) num(row.get("candidateId"))) - 1;
        if (candidateIndex < 0 || candidateIndex >= candidates.size()) continue;
        Map<String, Object> candidate = asMap(candidates.get(candidateIndex));
        String keyText = RagEngine.cleanDisplayText(row.get("keyText"));
        if (keyText.isBlank()) continue;
        out.add(map(
          "id", hits.get(candidateIndex).get("id"),
          "documentId", candidate.get("documentId"),
          "filename", candidate.get("filename"),
          "fileType", candidate.get("fileType"),
          "chunkIndex", candidate.get("chunkIndex"),
          "score", candidate.get("score"),
          "content", keyText,
          "keyText", keyText,
          "reason", RagEngine.cleanDisplayText(row.get("reason"))
        ));
      }
      if (!out.isEmpty()) return out;
    } catch (Exception ignored) {
      // 如果二次分析失败，仍返回本地整理后的依据，避免问答失败。
    }
    return RagEngine.quickCitations(hits);
  }

  static List<Object> parseJsonArray(String raw) {
    String text = s(raw).trim()
      .replaceFirst("(?is)^```json\\s*", "")
      .replaceFirst("(?is)^```\\s*", "")
      .replaceFirst("(?is)```$", "")
      .trim();
    int start = text.indexOf('[');
    int end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return new ArrayList<>();
    Object parsed = Json.parse(text.substring(start, end + 1));
    return parsed instanceof List<?> list ? new ArrayList<>(list) : new ArrayList<>();
  }

  static void chatHistory(HttpExchange ex, Map<String, Object> db, Map<String, Object> user) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "chatMessages")) if (s(user.get("id")).equals(s(asMap(item).get("ownerUserId")))) items.add(item);
    json(ex, 200, map("items", items));
  }

  static void chatOne(HttpExchange ex, Map<String, Object> db, String id, Map<String, Object> user) throws IOException {
    Map<String, Object> item = byId(list(db, "chatMessages"), id);
    if (item == null || user == null || !s(user.get("id")).equals(s(item.get("ownerUserId")))) { json(ex, 404, map("error", "Chat history not found")); return; }
    json(ex, 200, item);
  }

  static void chatDelete(HttpExchange ex, Map<String, Object> db, String id, Map<String, Object> user) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    list(db, "chatMessages").removeIf(x -> id.equals(s(asMap(x).get("id"))) && s(user.get("id")).equals(s(asMap(x).get("ownerUserId"))));
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void logs(HttpExchange ex, Map<String, Object> db, Map<String, Object> user) throws IOException {
    if (user == null || !"admin".equals(s(user.get("role")))) { json(ex, 403, map("error", "Only admins can view logs")); return; }
    json(ex, 200, map("items", list(db, "aiLogs")));
  }

  static void logOne(HttpExchange ex, Map<String, Object> db, String id, Map<String, Object> user) throws IOException {
    if (user == null || !"admin".equals(s(user.get("role")))) { json(ex, 403, map("error", "Only admins can view logs")); return; }
    Map<String, Object> log = byId(list(db, "aiLogs"), id);
    if (log == null) { json(ex, 404, map("error", "Log not found")); return; }
    json(ex, 200, log);
  }

  static void logDelete(HttpExchange ex, Map<String, Object> db, String id, Map<String, Object> user) throws IOException {
    if (user == null || !"admin".equals(s(user.get("role")))) { json(ex, 403, map("error", "Only admins can delete logs")); return; }
    removeId(list(db, "aiLogs"), id);
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void logsExport(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    List<String> ids = new ArrayList<>();
    if (b.get("ids") instanceof List<?> list) for (Object id : list) ids.add(s(id));
    int count = 0;
    Files.createDirectories(LOG_EXPORT_DIR);
    for (Object item : list(db, "aiLogs")) {
      Map<String, Object> log = asMap(item);
      if (ids.isEmpty() || ids.contains(s(log.get("id")))) {
        Path file = LOG_EXPORT_DIR.resolve(safeName(s(log.get("title"))) + "_" + s(log.get("id")) + ".json");
        writeText(file, Json.stringify(log));
        log.put("exported", true);
        log.put("exportPath", file.toString());
        count++;
      }
    }
    save(db);
    json(ex, 200, map("ok", true, "count", count));
  }

  static void logDownload(HttpExchange ex, Map<String, Object> db, String id, Map<String, Object> user) throws IOException {
    if (user == null || !"admin".equals(s(user.get("role")))) { json(ex, 403, map("error", "Only admins can download logs")); return; }
    Map<String, Object> log = byId(list(db, "aiLogs"), id);
    if (log == null) { json(ex, 404, map("error", "Log not found")); return; }
    Path file = LOG_EXPORT_DIR.resolve("log_" + id + ".json");
    writeText(file, Json.stringify(log));
    download(ex, file, file.getFileName().toString());
  }

  static void groups(HttpExchange ex, Map<String, Object> db, Map<String, Object> user) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    Set<String> mine = joinedGroups(db, s(user.get("id")));
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "userGroups")) {
      Map<String, Object> group = asMap(item);
      if ("admin".equals(s(user.get("role"))) || mine.contains(s(group.get("id")))) items.add(serializeGroup(db, user, group));
    }
    json(ex, 200, map("items", items));
  }

  static void groupSearch(HttpExchange ex, Map<String, Object> db, Map<String, Object> user, String keyword) throws IOException {
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    String key = keyword.toLowerCase();
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "userGroups")) {
      Map<String, Object> group = asMap(item);
      if (Boolean.FALSE.equals(group.get("searchable"))) continue;
      String hay = (s(group.get("name")) + " " + s(group.get("description"))).toLowerCase();
      if (key.isBlank() || hay.contains(key)) items.add(serializeGroup(db, user, group));
    }
    json(ex, 200, map("items", items));
  }

  static void groupCreate(HttpExchange ex, Map<String, Object> db, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    String name = s(b.get("name")).trim();
    if (name.isEmpty()) { json(ex, 400, map("error", "Group name is required")); return; }
    String gid = id("group");
    String now = now();
    Map<String, Object> group = map("id", gid, "name", name, "description", s(b.get("description")).trim(), "ownerUserId", user.get("id"), "searchable", !Boolean.FALSE.equals(b.get("searchable")), "joinPolicy", "approval", "createdAt", now, "updatedAt", now);
    list(db, "userGroups").add(0, group);
    list(db, "groupMembers").add(0, map("id", id("gm"), "groupId", gid, "userId", user.get("id"), "role", "owner", "joinedAt", now));
    save(db);
    json(ex, 201, serializeGroup(db, user, group));
  }

  static void groupPatch(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (!canAdminGroup(db, user, gid)) { json(ex, 403, map("error", "Only group owner/admin can edit this group")); return; }
    Map<String, Object> group = byId(list(db, "userGroups"), gid);
    if (group == null) { json(ex, 404, map("error", "Group not found")); return; }
    group.put("name", s(b.getOrDefault("name", group.get("name"))).trim());
    group.put("description", s(b.getOrDefault("description", group.get("description"))).trim());
    group.put("searchable", !Boolean.FALSE.equals(b.get("searchable")));
    group.put("updatedAt", now());
    save(db);
    json(ex, 200, serializeGroup(db, user, group));
  }

  static void groupDelete(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> user) throws IOException {
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (!canOwnGroup(db, user, gid)) { json(ex, 403, map("error", "Only group owner or system admin can delete this group")); return; }
    removeId(list(db, "userGroups"), gid);
    list(db, "groupMembers").removeIf(x -> gid.equals(s(asMap(x).get("groupId"))));
    list(db, "groupJoinRequests").removeIf(x -> gid.equals(s(asMap(x).get("groupId"))));
    list(db, "knowledgeBaseShares").removeIf(x -> gid.equals(s(asMap(x).get("groupId"))));
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void groupKbs(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> user) throws IOException {
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (user == null || member(db, s(user.get("id")), gid) == null) { json(ex, 403, map("error", "Only group members can view group knowledge bases")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "knowledgeBaseShares")) {
      Map<String, Object> share = asMap(item);
      if (gid.equals(s(share.get("groupId")))) {
        Map<String, Object> kb = byId(list(db, "knowledgeBases"), s(share.get("knowledgeBaseId")));
        if (kb != null && canRead(db, user, kb)) items.add(serializeKb(db, user, kb));
      }
    }
    json(ex, 200, map("items", items));
  }

  static void groupMembers(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> user) throws IOException {
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (user == null || member(db, s(user.get("id")), gid) == null) { json(ex, 403, map("error", "Only group members can view members")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "groupMembers")) {
      Map<String, Object> m = asMap(item);
      if (!gid.equals(s(m.get("groupId")))) continue;
      Map<String, Object> account = byId(list(db, "users"), s(m.get("userId")));
      items.add(map("id", m.get("id"), "groupId", gid, "userId", m.get("userId"), "role", m.get("role"), "joinedAt", m.get("joinedAt"), "username", account == null ? m.get("userId") : account.get("username"), "avatarId", account == null ? "wolf" : account.getOrDefault("avatarId", "wolf")));
    }
    json(ex, 200, map("items", items));
  }

  static void groupRole(HttpExchange ex, Map<String, Object> db, String gid, String uid, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (!canOwnGroup(db, user, gid)) { json(ex, 403, map("error", "Only group owner or system admin can change member roles")); return; }
    Map<String, Object> target = member(db, uid, gid);
    if (target == null || "owner".equals(s(target.get("role")))) { json(ex, 400, map("error", "Cannot change this member")); return; }
    String role = List.of("admin", "member", "viewer").contains(s(b.get("role"))) ? s(b.get("role")) : "member";
    target.put("role", role);
    save(db);
    json(ex, 200, target);
  }

  static void groupRemove(HttpExchange ex, Map<String, Object> db, String gid, String uid, Map<String, Object> user) throws IOException {
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    Map<String, Object> target = member(db, uid, gid);
    boolean selfLeave = user != null && uid.equals(s(user.get("id"))) && target != null && !"owner".equals(s(target.get("role")));
    boolean managerRemove = canAdminGroup(db, user, gid) && target != null && List.of("member", "viewer").contains(s(target.get("role")));
    boolean ownerRemove = canOwnGroup(db, user, gid) && target != null && !"owner".equals(s(target.get("role")));
    if (!selfLeave && !managerRemove && !ownerRemove) { json(ex, 403, map("error", "No permission to remove this member")); return; }
    list(db, "groupMembers").removeIf(x -> gid.equals(s(asMap(x).get("groupId"))) && uid.equals(s(asMap(x).get("userId"))) && !"owner".equals(s(asMap(x).get("role"))));
    save(db);
    json(ex, 200, map("ok", true));
  }

  static void joinRequest(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (user == null) { json(ex, 401, map("error", "Please log in")); return; }
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (member(db, s(user.get("id")), gid) != null) { json(ex, 400, map("error", "You are already in this group")); return; }
    Map<String, Object> req = map("id", id("gjr"), "groupId", gid, "userId", user.get("id"), "username", user.get("username"), "message", s(b.get("message")), "status", "pending", "createdAt", now());
    list(db, "groupJoinRequests").add(0, req);
    save(db);
    json(ex, 201, req);
  }

  static void joinRequests(HttpExchange ex, Map<String, Object> db, String gid, Map<String, Object> user) throws IOException {
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (!canManageGroup(db, user, gid)) { json(ex, 403, map("error", "Only group owner or admin can view join requests")); return; }
    List<Object> items = new ArrayList<>();
    for (Object item : list(db, "groupJoinRequests")) {
      Map<String, Object> req = asMap(item);
      if (gid.equals(s(req.get("groupId"))) && "pending".equals(s(req.get("status")))) items.add(req);
    }
    json(ex, 200, map("items", items));
  }

  static void joinReview(HttpExchange ex, Map<String, Object> db, String gid, String rid, Map<String, Object> b) throws IOException {
    Map<String, Object> user = user(ex, db, s(b.get("userId")));
    if (!isEnterpriseUser(user)) { json(ex, 403, map("error", "用户组功能仅对企业用户开放")); return; }
    if (!canAdminGroup(db, user, gid)) { json(ex, 403, map("error", "Only group owner/admin can review join requests")); return; }
    Map<String, Object> req = byId(list(db, "groupJoinRequests"), rid);
    if (req == null) { json(ex, 404, map("error", "Join request not found")); return; }
    boolean ok = "approve".equals(s(b.get("action")));
    req.put("status", ok ? "approved" : "rejected");
    req.put("reviewedBy", user.get("id"));
    req.put("reviewedAt", now());
    if (ok && member(db, s(req.get("userId")), gid) == null) list(db, "groupMembers").add(0, map("id", id("gm"), "groupId", gid, "userId", req.get("userId"), "role", "member", "joinedAt", now()));
    save(db);
    json(ex, 200, req);
  }

  static List<Map<String, Object>> search(Map<String, Object> db, String kbId, String question, Set<String> docIds, int top) {
    List<String> terms = Arrays.stream(question.split("\\s+|，|。|、|！|？|,|\\.|!|\\?")).filter(x -> !x.isBlank()).toList();
    List<Map<String, Object>> hits = new ArrayList<>();
    for (Object item : list(db, "chunks")) {
      Map<String, Object> chunk = asMap(item);
      if (!kbId.equals(s(chunk.get("knowledgeBaseId")))) continue;
      if (!docIds.isEmpty() && !docIds.contains(s(chunk.get("documentId")))) continue;
      String content = s(chunk.get("content"));
      double score = 0;
      String lower = content.toLowerCase();
      for (String term : terms) if (lower.contains(term.toLowerCase())) score += 1;
      if (score > 0 || hits.size() < top) {
        Map<String, Object> hit = new LinkedHashMap<>(chunk);
        hit.put("score", score);
        hits.add(hit);
      }
    }
    hits.sort((a, b) -> Double.compare(num(b.get("score")), num(a.get("score"))));
    return hits.size() > top ? new ArrayList<>(hits.subList(0, top)) : hits;
  }

  static String context(List<Map<String, Object>> hits, int max) {
    StringBuilder out = new StringBuilder();
    for (Map<String, Object> hit : hits) {
      String part = "[" + hit.get("filename") + " #" + hit.get("chunkIndex") + "]\n" + s(hit.get("content")) + "\n\n";
      if (out.length() + part.length() > max) break;
      out.append(part);
    }
    return out.toString();
  }

  static String extractText(String filename, byte[] bytes) {
    try {
      return s(TIKA.parseToString(new ByteArrayInputStream(bytes))).trim();
    } catch (Exception e) {
      throw new RuntimeException("文档解析失败：" + e.getMessage());
    }
  }

  static List<String> chunk(String text, int size, int overlap) {
    text = s(text).trim();
    List<String> chunks = new ArrayList<>();
    if (text.isEmpty()) return chunks;
    for (int i = 0; i < text.length();) {
      int end = Math.min(text.length(), i + size);
      chunks.add(text.substring(i, end));
      if (end == text.length()) break;
      i = Math.max(i + 1, end - overlap);
    }
    return chunks;
  }

  static void serveStatic(HttpExchange ex) throws IOException {
    String raw = dec(ex.getRequestURI().getPath());
    if (raw.equals("/")) raw = "/index.html";
    Path file = PUBLIC_DIR.resolve(raw.substring(1)).normalize();
    if (!file.startsWith(PUBLIC_DIR) || !Files.exists(file) || Files.isDirectory(file)) { text(ex, 404, "Not found"); return; }
    byte[] data = Files.readAllBytes(file);
    ex.getResponseHeaders().set("Content-Type", mime(file));
    ex.sendResponseHeaders(200, data.length);
    try (OutputStream out = ex.getResponseBody()) { out.write(data); }
  }

  static void download(HttpExchange ex, Path file, String filename) throws IOException {
    if (!Files.exists(file)) { json(ex, 404, map("error", "File not found")); return; }
    byte[] data = Files.readAllBytes(file);
    Headers h = ex.getResponseHeaders();
    h.set("Content-Type", "application/octet-stream");
    h.set("Content-Disposition", "attachment; filename*=UTF-8''" + URLEncoder.encode(filename, StandardCharsets.UTF_8));
    ex.sendResponseHeaders(200, data.length);
    try (OutputStream out = ex.getResponseBody()) { out.write(data); }
  }

  static synchronized Map<String, Object> db() throws IOException {
    if (cachedDb != null) return asMap(cachedDb);
    try (Connection conn = sqlite(); Statement st = conn.createStatement(); ResultSet rs = st.executeQuery("select value from app_state where key='db'")) {
      if (rs.next()) {
        cachedDb = Json.parse(rs.getString(1));
      } else {
        cachedDb = emptyDb();
        save(asMap(cachedDb));
      }
      return asMap(cachedDb);
    } catch (Exception e) {
      throw new IOException("SQLite 读取失败：" + e.getMessage(), e);
    }
  }

  static synchronized void save(Map<String, Object> db) throws IOException {
    normalize(db);
    String json = Json.stringify(db);
    try (Connection conn = sqlite(); PreparedStatement ps = conn.prepareStatement("insert into app_state(key,value,updated_at) values('db',?,?) on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at")) {
      ps.setString(1, json);
      ps.setString(2, now());
      ps.executeUpdate();
      cachedDb = db;
      writeText(DB_PATH, json);
    } catch (Exception e) {
      throw new IOException("SQLite 保存失败：" + e.getMessage(), e);
    }
  }

  static void initSqlite() throws Exception {
    try (Connection conn = sqlite(); Statement st = conn.createStatement()) {
      st.executeUpdate("create table if not exists app_state(key text primary key, value text not null, updated_at text not null)");
      st.executeUpdate("create table if not exists audit_events(id text primary key, type text not null, user_id text, payload text, created_at text not null)");
      try (ResultSet rs = st.executeQuery("select value from app_state where key='db'")) {
        if (!rs.next()) {
          String seed = Files.exists(DB_PATH)
            ? Files.readString(DB_PATH, StandardCharsets.UTF_8).replaceFirst("^\\uFEFF", "")
            : Json.stringify(emptyDb());
          try (PreparedStatement ps = conn.prepareStatement("insert into app_state(key,value,updated_at) values('db',?,?)")) {
            ps.setString(1, seed);
            ps.setString(2, now());
            ps.executeUpdate();
          }
          writeText(DB_PATH, seed);
        }
      }
    }
  }

  static Connection sqlite() throws Exception {
    return DriverManager.getConnection("jdbc:sqlite:" + SQLITE_PATH.toAbsolutePath());
  }

  static Map<String, Object> emptyDb() {
    return map("knowledgeBases", new ArrayList<>(), "documents", new ArrayList<>(), "chunks", new ArrayList<>(), "chatMessages", new ArrayList<>(), "aiLogs", new ArrayList<>(), "users", new ArrayList<>(), "userGroups", new ArrayList<>(), "groupMembers", new ArrayList<>(), "groupJoinRequests", new ArrayList<>(), "knowledgeBaseShares", new ArrayList<>());
  }

  static void normalize(Map<String, Object> db) {
    for (String key : List.of("knowledgeBases", "documents", "chunks", "chatMessages", "aiLogs", "users", "userGroups", "groupMembers", "groupJoinRequests", "knowledgeBaseShares")) if (!(db.get(key) instanceof List<?>)) db.put(key, new ArrayList<>());
    for (Object item : list(db, "users")) {
      Map<String, Object> user = asMap(item);
      if (s(user.get("userType")).isBlank()) user.put("userType", "admin".equals(s(user.get("role"))) ? "enterprise" : "personal");
    }
  }

  static Map<String, Object> publicUser(Map<String, Object> user) {
    return map("id", user.get("id"), "username", user.get("username"), "role", user.getOrDefault("role", "user"), "userType", user.getOrDefault("userType", "admin".equals(s(user.get("role"))) ? "enterprise" : "personal"), "avatarId", user.getOrDefault("avatarId", "wolf"), "brandAvatarId", user.getOrDefault("brandAvatarId", "wolf"), "busyAvatarId", user.getOrDefault("busyAvatarId", "wolf"), "aiAvatarId", user.getOrDefault("aiAvatarId", "wolf"), "createdAt", user.get("createdAt"), "updatedAt", user.get("updatedAt"));
  }

  static Map<String, Object> serializeKb(Map<String, Object> db, Map<String, Object> user, Map<String, Object> kb) {
    List<Object> groupIds = new ArrayList<>();
    List<Object> groups = new ArrayList<>();
    for (Object item : list(db, "knowledgeBaseShares")) {
      Map<String, Object> share = asMap(item);
      if (!s(kb.get("id")).equals(s(share.get("knowledgeBaseId")))) continue;
      String gid = s(share.get("groupId"));
      groupIds.add(gid);
      Map<String, Object> group = byId(list(db, "userGroups"), gid);
      if (group != null) groups.add(map("id", gid, "name", group.get("name")));
    }
    Map<String, Object> out = new LinkedHashMap<>(kb);
    out.put("isOwner", s(user.get("id")).equals(s(kb.get("ownerUserId"))));
    out.put("sharedGroupIds", groupIds);
    out.put("sharedGroups", groups);
    out.put("documentCount", docsOf(db, s(kb.get("id"))).size());
    return out;
  }

  static Map<String, Object> serializeGroup(Map<String, Object> db, Map<String, Object> user, Map<String, Object> group) {
    Map<String, Object> member = member(db, s(user.get("id")), s(group.get("id")));
    Map<String, Object> out = new LinkedHashMap<>(group);
    out.put("myRole", member == null ? "" : member.get("role"));
    out.put("canReviewRequests", canAdminGroup(db, user, s(group.get("id"))));
    out.put("canEditGroup", canAdminGroup(db, user, s(group.get("id"))));
    out.put("canDeleteGroup", canOwnGroup(db, user, s(group.get("id"))));
    out.put("canChangeMemberRoles", canOwnGroup(db, user, s(group.get("id"))));
    out.put("canRemoveBasicMembers", canAdminGroup(db, user, s(group.get("id"))));
    out.put("memberCount", list(db, "groupMembers").stream().filter(x -> s(group.get("id")).equals(s(asMap(x).get("groupId")))).count());
    if (member != null) out.put("joinStatus", "joined");
    else if (pending(db, s(user.get("id")), s(group.get("id")))) out.put("joinStatus", "pending");
    return out;
  }

  static boolean canRead(Map<String, Object> db, Map<String, Object> user, Map<String, Object> kb) {
    if (user == null || kb == null) return false;
    if (s(user.get("id")).equals(s(kb.get("ownerUserId")))) return true;
    for (Object item : list(db, "knowledgeBaseShares")) {
      Map<String, Object> share = asMap(item);
      if (s(kb.get("id")).equals(s(share.get("knowledgeBaseId"))) && member(db, s(user.get("id")), s(share.get("groupId"))) != null) return true;
    }
    return false;
  }

  static boolean canManageKb(Map<String, Object> user, Map<String, Object> kb) {
    return user != null && kb != null && s(user.get("id")).equals(s(kb.get("ownerUserId")));
  }

  static boolean canManageGroup(Map<String, Object> db, Map<String, Object> user, String gid) {
    return canAdminGroup(db, user, gid);
  }

  static boolean canOwnGroup(Map<String, Object> db, Map<String, Object> user, String gid) {
    if (user == null) return false;
    if ("admin".equals(s(user.get("role")))) return true;
    Map<String, Object> group = byId(list(db, "userGroups"), gid);
    if (group != null && s(user.get("id")).equals(s(group.get("ownerUserId")))) return true;
    Map<String, Object> member = member(db, s(user.get("id")), gid);
    return member != null && "owner".equals(s(member.get("role")));
  }

  static boolean canAdminGroup(Map<String, Object> db, Map<String, Object> user, String gid) {
    if (canOwnGroup(db, user, gid)) return true;
    Map<String, Object> member = member(db, s(user.get("id")), gid);
    return member != null && "admin".equals(s(member.get("role")));
  }

  static Map<String, Object> member(Map<String, Object> db, String uid, String gid) {
    for (Object item : list(db, "groupMembers")) {
      Map<String, Object> member = asMap(item);
      if (uid.equals(s(member.get("userId"))) && gid.equals(s(member.get("groupId")))) return member;
    }
    return null;
  }

  static boolean pending(Map<String, Object> db, String uid, String gid) {
    for (Object item : list(db, "groupJoinRequests")) {
      Map<String, Object> req = asMap(item);
      if (uid.equals(s(req.get("userId"))) && gid.equals(s(req.get("groupId"))) && "pending".equals(s(req.get("status")))) return true;
    }
    return false;
  }

  static Set<String> joinedGroups(Map<String, Object> db, String uid) {
    Set<String> ids = new HashSet<>();
    for (Object item : list(db, "groupMembers")) if (uid.equals(s(asMap(item).get("userId")))) ids.add(s(asMap(item).get("groupId")));
    return ids;
  }

  static List<Object> docsOf(Map<String, Object> db, String kbId) {
    List<Object> docs = new ArrayList<>();
    for (Object item : list(db, "documents")) if (kbId.equals(s(asMap(item).get("knowledgeBaseId")))) docs.add(item);
    return docs;
  }

  static Map<String, Object> user(HttpExchange ex, Map<String, Object> db, String fallback) {
    String id = ex.getRequestHeaders().getFirst("X-User-Id");
    if (id == null || id.isBlank()) id = fallback;
    return byId(list(db, "users"), id);
  }

  static void ensureKb(Map<String, Object> kb) throws IOException {
    if (s(kb.get("folderPath")).isBlank()) kb.put("folderPath", KB_DIR.resolve(safeName(s(kb.get("name"))) + "_" + s(kb.get("id"))).toString());
    Files.createDirectories(Paths.get(s(kb.get("folderPath"))));
  }

  static Map<String, Object> bucket(String iso) {
    LocalDateTime t = LocalDateTime.parse(iso);
    int h = t.getHour();
    return map("date", t.toLocalDate().toString(), "timeLevel", h < 6 ? "凌晨" : h < 12 ? "上午" : h < 18 ? "下午" : "晚上");
  }

  static Matcher match(String text, String regex) {
    Matcher m = Pattern.compile(regex).matcher(text);
    return m.find() ? m : null;
  }

  static Map<String, Object> body(HttpExchange ex) throws IOException {
    String raw = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
    return raw.isBlank() ? new LinkedHashMap<>() : asMap(Json.parse(raw));
  }

  static void json(HttpExchange ex, int status, Object value) throws IOException {
    byte[] data = Json.stringify(value).getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(status, data.length);
    try (OutputStream out = ex.getResponseBody()) { out.write(data); }
  }

  static void text(HttpExchange ex, int status, String value) throws IOException {
    byte[] data = value.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
    ex.sendResponseHeaders(status, data.length);
    try (OutputStream out = ex.getResponseBody()) { out.write(data); }
  }

  static Map<String, String> query(URI uri) {
    Map<String, String> out = new HashMap<>();
    if (uri.getRawQuery() == null) return out;
    for (String part : uri.getRawQuery().split("&")) {
      int i = part.indexOf('=');
      if (i >= 0) out.put(dec(part.substring(0, i)), dec(part.substring(i + 1)));
      else out.put(dec(part), "");
    }
    return out;
  }

  static Map<String, String> loadEnv() {
    Map<String, String> env = new HashMap<>();
    Path file = ROOT.resolve(".env");
    if (!Files.exists(file)) return env;
    try {
      for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
        int i = line.indexOf('=');
        if (i > 0 && !line.trim().startsWith("#")) env.put(line.substring(0, i).trim(), line.substring(i + 1).trim());
      }
    } catch (IOException ignored) {}
    return env;
  }

  static String env(String key, String def) {
    String value = System.getenv(key);
    if (value != null && !value.isBlank()) return value;
    value = DOTENV.get(key);
    return value == null || value.isBlank() ? def : value;
  }

  static String deepSeekModel() {
    return env("DEEPSEEK_MODEL", env("DEEPSEEK_CHAT_MODEL", "deepseek-v4-flash"));
  }

  static String sha(String value) {
    try {
      byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder();
      for (byte b : bytes) out.append(String.format("%02x", b));
      return out.toString();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }

  static boolean verify(String password, Map<String, Object> user) {
    String salt = s(user.get("salt"));
    if (!salt.isEmpty() && !s(user.get("passwordHash")).isEmpty()) return sha(password + salt).equals(s(user.get("passwordHash")));
    return password.equals(s(user.get("password")));
  }

  static Map<String, Object> map(Object... kv) {
    Map<String, Object> out = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) out.put(String.valueOf(kv[i]), kv[i + 1]);
    return out;
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> asMap(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  static List<Object> list(Map<String, Object> map, String key) {
    Object value = map.get(key);
    if (value instanceof List<?>) return (List<Object>) value;
    List<Object> list = new ArrayList<>();
    map.put(key, list);
    return list;
  }

  static Map<String, Object> byId(List<Object> list, String id) {
    if (id == null) return null;
    for (Object item : list) {
      Map<String, Object> map = asMap(item);
      if (id.equals(s(map.get("id")))) return map;
    }
    return null;
  }

  static void removeId(List<Object> list, String id) {
    list.removeIf(item -> id.equals(s(asMap(item).get("id"))));
  }

  static String s(Object value) { return value == null ? "" : String.valueOf(value); }
  static double num(Object value) { try { return Double.parseDouble(s(value)); } catch (Exception e) { return 0; } }
  static String left(String value, int limit) { String text = s(value); return text.length() <= limit ? text : text.substring(0, limit); }
  static boolean strongPassword(String password) { return password != null && password.length() >= 8 && password.matches(".*[A-Za-z].*") && password.matches(".*\\d.*"); }
  static boolean isEnterpriseUser(Map<String, Object> user) { return user != null && ("admin".equals(s(user.get("role"))) || "enterprise".equals(s(user.get("userType")))); }
  static String id(String prefix) { return prefix + "_" + System.currentTimeMillis() + "_" + Math.abs(ThreadLocalRandom.current().nextInt(100000)); }
  static String now() { return LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME); }
  static String avatar(String id) { return AVATARS.contains(id) ? id : "wolf"; }
  static String ext(String name) { int i = name.lastIndexOf('.'); return i >= 0 ? name.substring(i).toLowerCase() : ""; }
  static String sourceKind(String name) { String e = ext(name); if (e.equals(".pdf")) return "pdf"; if (List.of(".xls", ".xlsx", ".csv").contains(e)) return "table"; if (List.of(".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff").contains(e)) return "image"; return "text"; }
  static String safeName(String value) { return value.replaceAll("[\\\\/:*?\"<>|]", "_"); }
  static String dec(String value) { return URLDecoder.decode(value, StandardCharsets.UTF_8); }
  static String mime(Path path) { String p = path.toString().toLowerCase(); if (p.endsWith(".html")) return "text/html; charset=utf-8"; if (p.endsWith(".css")) return "text/css; charset=utf-8"; if (p.endsWith(".js")) return "application/javascript; charset=utf-8"; if (p.endsWith(".png")) return "image/png"; if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg"; return "application/octet-stream"; }
  static void writeText(Path path, String text) throws IOException { Files.createDirectories(path.getParent()); Files.writeString(path, text, StandardCharsets.UTF_8); }
}
