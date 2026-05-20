# 知枢 AI 知识库平台 Java版

这是 Java 后端版本，前端沿用原项目 `public`。

## 启动

```powershell
.\start-java.ps1
```

访问：

```text
http://localhost:3001
```

## 当前关键能力

- SQLite 持久化：主数据保存到 `data/app.db`，同时保留 `data/db.json` 作为可读备份。
- 后台文档任务：上传后立即返回，文档状态为 `processing`，后台完成解析、切片、向量化。
- 文档解析：已接入 Apache Tika App 2.9.2，可解析 PDF、Word、Excel、PPT、HTML、XML、RTF、CSV、TXT、Markdown 等常见文档。
- 混合检索：RAG 检索使用本地向量余弦相似度 + BM25 关键词相关度。
- 流式问答：前端调用 `/api/chat-stream`，AI 回复会边生成边显示，最后补全资料依据和日志。
- 权限校验：知识库、文档下载、日志下载、上传、删除、问答都会校验用户可读/可管理权限。

说明：扫描版 PDF / 图片 OCR 取决于运行环境是否安装 Tesseract；没有安装时，Tika 只能提取文档中已有的文本层。
