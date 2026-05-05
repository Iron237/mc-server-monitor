# Minecraft Server Monitor

一个给 Minecraft 服务器玩家看的网页监控面板。当前版本不依赖第三方 npm 包，直接用 Node.js 内置模块运行。

## 已实现功能

- 同时监控多个 Minecraft Java 服务器
- 显示每台服务器在线/离线、延迟、版本、MOTD、在线人数
- 可选 Minecraft Query 协议，读取完整在线玩家列表
- 每台服务器独立统计玩家当前会话时长和累计在线时长
- 显示整机 CPU、内存、磁盘资源
- 按 PID 或服务器监听端口识别每台服务器的 Java 进程资源
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

## 多服务器配置

主要配置写在 `.env` 的 `SERVERS` 里。示例中第二个服务器端口是 `2000`：

```env
SERVERS=[{"id":"server1","name":"生存服","host":"127.0.0.1","port":25565,"queryEnabled":true,"queryHost":"127.0.0.1","queryPort":25565,"processPort":25565,"logBackfillEnabled":true,"logPath":"G:/临时处理"},{"id":"server2","name":"服务器2","host":"127.0.0.1","port":2000,"queryEnabled":true,"queryHost":"127.0.0.1","queryPort":2000,"processPort":2000}]
```

每个服务器对象支持：

```json
{
  "id": "server2",
  "name": "服务器2",
  "host": "127.0.0.1",
  "port": 2000,
  "queryEnabled": true,
  "queryHost": "127.0.0.1",
  "queryPort": 2000,
  "pid": 12345,
  "processPort": 2000,
  "processName": "java",
  "logBackfillEnabled": true,
  "logPath": "G:/临时处理"
}
```

资源进程识别优先级：

1. `pid`：直接指定进程 PID，最准确。
2. `processPort`：查找正在监听这个 TCP 端口的进程，适合一台机器跑多个 MC 服。
3. `processName`：按进程名查找，例如 `java`，只适合单服或粗略查看。

如果同时配置了 `pid` 和 `processPort`，会优先使用 `pid`。

## 准确统计在线时长

Minecraft 状态 Ping 默认只保证返回在线人数，不保证返回完整玩家名单。有些服务器会隐藏玩家样本，或者只返回部分玩家。

要让在线玩家列表和在线时长统计准确，建议开启 Query。每个服务端的 `server.properties`：

```properties
enable-query=true
query.port=25565
```

第二个服务器如果端口是 `2000`：

```properties
enable-query=true
query.port=2000
```

然后在 `.env` 的对应服务器对象里设置：

```json
{"queryEnabled":true,"queryPort":2000}
```

如果没有开启 Query，面板仍会显示服务器在线状态、连接延迟和在线人数；玩家时长只能基于服务器状态样本估算，或者无法按玩家统计。

## 日志回填在线时长

如果之前没有开启 Query 或监控程序没有运行，可以用服务端日志补回一部分在线时长。程序会扫描 `.log` 和 `.log.gz`，匹配玩家上线和下线事件，把两者时间相减后合并到累计在线时长。

已支持这些 NeoForge/Minecraft 日志事件：

```text
Kang62 logged in with entity id ...
Kang62 joined the game
IronGod777 lost connection: Disconnected
IronGod777 left the game
```

已支持你当前日志里的时间格式：

```text
[045月2026 18:50:01.323]
[0452026 19:07:26.869]
```

上面两种都会按 `2026-05-04` 解析。

配置方式：

```json
{"logBackfillEnabled":true,"logPath":"G:/临时处理"}
```

你的日志目录可以直接配置为：

```json
{"logBackfillEnabled":true,"logPath":"Y:/Users/123/Desktop/航空学server/logs"}
```

Windows 路径建议在 JSON 里用 `/`，避免反斜杠转义问题。已导入的会话会记录到 `data/player-stats.json`，后续重复扫描不会重复累加。

默认限制：

```env
LOG_BACKFILL_MAX_FILES=80
LOG_BACKFILL_MAX_SESSION_HOURS=24
```

`LOG_BACKFILL_MAX_SESSION_HOURS` 用来避免服务器崩溃、日志缺失下线记录时产生异常超长会话。你提供的 NeoForge 日志时间戳格式 `[264月2026 11:48:55.373]` 已支持。

## API

```text
GET /api/status
GET /api/status/:serverId
GET /api/players
GET /api/players/:serverId
GET /health
```

## 部署建议

局域网内使用时，把 `.env` 设置为：

```env
HOST=0.0.0.0
PORT=3000
```

然后让玩家访问：

```text
http://服务器IP:3000
```

需要放行：

```text
TCP 3000       监控网页
TCP 25565      服务器1 Minecraft
UDP 25565      服务器1 Query
TCP 2000       服务器2 Minecraft
UDP 2000       服务器2 Query
```

公网使用时建议放到 Nginx、Caddy 或 Cloudflare Tunnel 后面，并限制管理机器上的防火墙规则。
