package com.zhishu;

import java.util.*;

final class Json {
  private Json() {}

  static Object parse(String text) {
    return new Parser(text == null ? "" : text).parse();
  }

  static String stringify(Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out);
    return out.toString();
  }

  private static void write(Object value, StringBuilder out) {
    if (value == null) {
      out.append("null");
      return;
    }
    if (value instanceof String s) {
      out.append('"');
      for (int i = 0; i < s.length(); i++) {
        char c = s.charAt(i);
        switch (c) {
          case '"' -> out.append("\\\"");
          case '\\' -> out.append("\\\\");
          case '\n' -> out.append("\\n");
          case '\r' -> out.append("\\r");
          case '\t' -> out.append("\\t");
          default -> {
            if (c < 32) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
          }
        }
      }
      out.append('"');
      return;
    }
    if (value instanceof Number || value instanceof Boolean) {
      out.append(value);
      return;
    }
    if (value instanceof Map<?, ?> map) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!first) out.append(',');
        first = false;
        write(String.valueOf(entry.getKey()), out);
        out.append(':');
        write(entry.getValue(), out);
      }
      out.append('}');
      return;
    }
    if (value instanceof Iterable<?> iterable) {
      out.append('[');
      boolean first = true;
      for (Object item : iterable) {
        if (!first) out.append(',');
        first = false;
        write(item, out);
      }
      out.append(']');
      return;
    }
    write(String.valueOf(value), out);
  }

  private static final class Parser {
    private final String text;
    private int pos;

    Parser(String text) {
      this.text = text;
    }

    Object parse() {
      skip();
      Object value = value();
      skip();
      return value;
    }

    private Object value() {
      skip();
      char c = peek();
      if (c == '{') return object();
      if (c == '[') return array();
      if (c == '"') return string();
      if (starts("true")) {
        pos += 4;
        return true;
      }
      if (starts("false")) {
        pos += 5;
        return false;
      }
      if (starts("null")) {
        pos += 4;
        return null;
      }
      return number();
    }

    private Map<String, Object> object() {
      pos++;
      Map<String, Object> map = new LinkedHashMap<>();
      skip();
      if (peek() == '}') {
        pos++;
        return map;
      }
      while (true) {
        skip();
        String key = string();
        skip();
        expect(':');
        map.put(key, value());
        skip();
        if (peek() == '}') {
          pos++;
          return map;
        }
        expect(',');
      }
    }

    private List<Object> array() {
      pos++;
      List<Object> list = new ArrayList<>();
      skip();
      if (peek() == ']') {
        pos++;
        return list;
      }
      while (true) {
        list.add(value());
        skip();
        if (peek() == ']') {
          pos++;
          return list;
        }
        expect(',');
      }
    }

    private String string() {
      expect('"');
      StringBuilder out = new StringBuilder();
      while (pos < text.length()) {
        char c = text.charAt(pos++);
        if (c == '"') return out.toString();
        if (c != '\\') {
          out.append(c);
          continue;
        }
        char e = text.charAt(pos++);
        switch (e) {
          case '"' -> out.append('"');
          case '\\' -> out.append('\\');
          case '/' -> out.append('/');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> {
            out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
            pos += 4;
          }
          default -> out.append(e);
        }
      }
      throw new IllegalArgumentException("Unclosed JSON string");
    }

    private Number number() {
      int start = pos;
      while (pos < text.length() && "-+0123456789.eE".indexOf(text.charAt(pos)) >= 0) pos++;
      String raw = text.substring(start, pos);
      if (raw.contains(".") || raw.contains("e") || raw.contains("E")) return Double.parseDouble(raw);
      return Long.parseLong(raw);
    }

    private boolean starts(String value) {
      return text.startsWith(value, pos);
    }

    private char peek() {
      return pos < text.length() ? text.charAt(pos) : 0;
    }

    private void expect(char expected) {
      if (peek() != expected) throw new IllegalArgumentException("Expected " + expected + " at " + pos);
      pos++;
    }

    private void skip() {
      while (pos < text.length() && Character.isWhitespace(text.charAt(pos))) pos++;
    }
  }
}
