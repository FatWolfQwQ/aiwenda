# 知枢 AI 知识库平台

本地直运行版原型，不需要 Docker。

## 打开方式

推荐双击项目根目录里的：

```text
打开网站.vbs
```

它会自动隐藏启动后端服务，并打开：

```text
http://localhost:3000
```

如果不想打开浏览器，只想后台启动服务，可以运行：

```text
启动服务-隐藏.ps1
```

如需关闭本地服务，可以运行：

```text
关闭网站.ps1
```

## 当前功能

- 创建、选择、删除知识库
- 上传常见文档：txt、md、docx、pptx、xlsx、csv、pdf、图片等
- 扫描 PDF / 图片可通过本地 OCR 识别文字
- 文档自动切片和本地向量化
- AI 问答：本地检索知识库片段，再调用 DeepSeek `deepseek-v4-flash` 生成回答
- AI 问答支持整个知识库或指定文档
- 聊天记录可回溯并恢复当时的知识库和文档范围
- 资料依据支持文本摘录；PDF、图片、表格会自动识别并提取关键文字
- 知识库 / 文档 / 日志可打开所在位置
- 问答日志可查看、删除、导出

## 当前接口

- 后端健康检查：`GET /api/health`
- 选择文件夹：`POST /api/select-folder`
- 知识库列表：`GET /api/knowledge-bases`
- 创建知识库：`POST /api/knowledge-bases`
- 打开知识库文件夹：`POST /api/knowledge-bases/:id/open-folder`
- 文档列表：`GET /api/documents?knowledgeBaseId=xxx`
- 上传文档并处理：`POST /api/documents`
- AI 问答：`POST /api/chat`
- 聊天记录：`GET /api/chat-history`
- 打开文档所在位置：`POST /api/documents/:id/open-location`
- 删除文档：`DELETE /api/documents/:id`
- 删除知识库：`DELETE /api/knowledge-bases/:id`



## GitHub / 试运营配置

首次运行前，请复制 `.env.example` 为 `.env`，并填写：

```text
DEEPSEEK_API_KEY=你的 DeepSeek API Key
ADMIN_REGISTER_KEY=你的管理员注册密钥
```

如果是新电脑第一次运行，系统会自动创建空的 `data/db.json`。仓库不要上传 `.env`、`data/db.json`、上传文档、日志和本地知识库资料。
