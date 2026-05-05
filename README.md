# Minecraft Server Monitor

一个给 Minecraft 服务器玩家看的网页监控面板。当前版本不依赖第三方 npm 包，直接用 Node.js 内置模块运行。

## 已实现功能

- 服务器在线/离线状态
- Java 版服务器列表 Ping，显示延迟、版本、MOTD、在线人数和最大人数
- 可选 Minecraft Query 协议，读取完整在线玩家列表
- 在线玩家当前会话时长和累计在线时长统计
- 主机 CPU、内存、磁盘使用率
- 可选服务器进程资源监控，例如 `java`
- 浏览器仪表盘和 JSON API
- 运行数据持久化到 `data/player-stats.json`

## 快速开始

```powershell
Copy-Item config.example.env .env
notepad .env
node src/server.js
```

打开：

```text
http://localhost:3000
```

## 配置

主要配置写在 `.env`：

```env
PORT=3000
MC_HOST=127.0.0.1
MC_PORT=25565
MC_QUERY_ENABLED=false
MC_PROCESS_NAME=java
```

如果网页服务和 Minecraft 服务部署在同一台机器上，资源监控显示的是这台机器的资源。`MC_PROCESS_NAME=java` 会尝试列出 Java 进程资源。

## 准确统计在线时长

Minecraft 状态 Ping 默认只保证返回在线人数，不保证返回完整玩家名单。有些服务器会隐藏玩家样本，或者只返回部分玩家。

要让在线玩家列表和在线时长统计准确，建议开启 Query：

```properties
enable-query=true
query.port=25565
```

然后在 `.env` 中启用：

```env
MC_QUERY_ENABLED=true
MC_QUERY_PORT=25565
```

如果没有开启 Query，面板仍会显示服务器在线状态、连接延迟和在线人数；玩家时长只能基于服务器状态样本估算，或者无法按玩家统计。

## API

```text
GET /api/status
GET /api/players
GET /health
```

## 部署建议

局域网内使用时，把 `.env` 设置为：

```env
HOST=0.0.0.0
PORT=3000
MC_HOST=你的服务器地址
MC_PORT=25565
```

然后让玩家访问：

```text
http://服务器IP:3000
```

公网使用时建议放到 Nginx、Caddy 或 Cloudflare Tunnel 后面，并限制管理机器上的防火墙规则。
