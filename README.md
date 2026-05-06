# Minecraft Server Monitor

一个给 Minecraft 服务器玩家看的网页监控面板。零 npm 依赖，只用 Node.js 内置模块。

> Looking for English? See the language switcher (◐ button) in the top bar — the dashboard is bilingual.

## 功能

- 同时监控多个 Minecraft Java 服务器（Status Ping + 可选 Query）
- 实时显示在线/离线、延迟、版本、MOTD、在线人数
- 可选 RCON 读取 **TPS**（forge/spark/vanilla 三种命令自动尝试）
- 玩家会话与累计在线时长，支持每服独立排行榜以及多服 **汇总排行榜**
- 整机 CPU、内存、磁盘资源 + 每服进程 CPU/内存（按 CPU 自动排序）
- 支持配置每服 `worldPath`，监控存档所在盘符的磁盘
- 服务端日志回填（首次扫描后 mtime+size 缓存，后续轮询零开销）
- 历史趋势持久化到磁盘，重启不丢
- **Server-Sent Events 推送**，状态变化即时显示，不再 15 秒轮询
- 浏览器面板支持 **暗色模式** 与 **中英双语切换**
- 可选 **Bearer Token 鉴权**（保护 `/api/*`）
- 历史趋势图带 Y 轴刻度

## 快速开始

```powershell
Copy-Item config.example.env .env
Copy-Item servers.example.jsonc servers.jsonc
notepad servers.jsonc   # 多行可注释，改完保存
node src/server.js
```

打开 <http://localhost:3000>。运行测试：

```powershell
npm test
```

## 多服务器配置

**推荐**：把详细配置写到 `servers.jsonc`（多行、支持 `// 注释` 和尾逗号）：

```jsonc
// servers.jsonc
[
  {
    "id": "server1",
    "name": "生存服",
    "host": "127.0.0.1",
    "port": 25565,
    "queryEnabled": true,
    "queryPort": 25565,
    "processPort": 25565,
    "logBackfillEnabled": true,
    "logPath": "C:/Users/123/Desktop/航空学server/logs",
    "worldPath": "C:/Users/123/Desktop/航空学server/world"
  },
  {
    "id": "server2",
    "name": "服务器2",
    "host": "127.0.0.1",
    "port": 20000,
    "queryEnabled": true,
    "queryPort": 20000,
    "processPort": 20000,
  },
]
```

加载优先级（高 → 低）：

1. `.env` 里 `SERVERS_FILE=path/to/file.jsonc`（显式指定）
2. 项目根的 `servers.jsonc` 或 `servers.json`（自动发现）
3. `.env` 里的 `SERVERS=[...]` 单行 JSON（向后兼容）
4. `MC_HOST` / `MC_PORT` 等单服务器变量（向后兼容）

启动日志会打印当前来源，比如：

```
Loaded 2 server(s) from G:\mc-server-monitor\servers.jsonc
```

每个服务器对象支持：

| 字段 | 说明 |
|---|---|
| `id` | 唯一 id，路由里用 |
| `name` | 显示名 |
| `host` / `port` | Minecraft Status Ping 地址 |
| `queryEnabled`/`queryHost`/`queryPort` | 启用 UDP Query 拿完整玩家名单 |
| `pid` / `processPort` / `processName` | 进程匹配优先级：pid > port > name |
| `worldPath` | 额外监控的磁盘路径（通常是世界存档所在盘） |
| `logBackfillEnabled` / `logPath` | 启用日志回填 |
| `logBackfillMaxFiles` | 默认 80，扫描最近的 N 个 .log/.log.gz |
| `logBackfillMaxSessionHours` | 默认 24，超过这个时长的会话视为日志缺失，丢弃 |
| `rconEnabled` / `rconHost` / `rconPort` / `rconPassword` | 通过 RCON 读 TPS |

## 准确统计在线时长

Minecraft 状态 Ping 默认只保证返回在线人数，不保证返回完整玩家名单。要让玩家时长统计准确，建议开启 Query：

```properties
# server.properties
enable-query=true
query.port=25565
```

如果服务器只返回部分玩家（status sample 模式），监控会用 `STALE_SESSION_POLL_MULTIPLIER`（默认 4 个轮询周期 = 1 分钟）作为兜底，超时未再出现的玩家会自动结束会话，不会让排行榜无限累加。

## 日志回填

程序会扫描 `.log` 和 `.log.gz`，匹配玩家上线和下线事件。已支持以下时间格式：

```text
[2026-05-04T18:50:01.323]
[26Apr2026 11:48:55.373]
[045月2026 18:50:01.323]
[0452026 19:07:26.869]
[12:34:56]                     # 时间格式时配合文件名/mtime 推断日期
```

第二轮以后只重新解析 mtime 或大小变化的文件；扫到的会话用 `(playerKey, startAt, endAt)` 去重，不会重复累加。

页面上的「同步日志」按钮触发 `POST /api/backfill/:serverId`：

- `已同步`：日志里可识别的会话已全部写入统计
- `未同步`：仍有完整会话尚未写入

## 鉴权

设置 `AUTH_TOKEN=xxx` 后，`/api/*` 都会要求以下任一：

```http
Authorization: Bearer xxx
```

或 URL 加 `?token=xxx`，或携带 `mc_token=xxx` cookie。`/health` 与静态资源保持公开。

## API

```text
GET  /api/status              全量状态
GET  /api/status/:serverId    单服状态
GET  /api/players             各服在线玩家与排行榜
GET  /api/players/:serverId   单服玩家
GET  /api/leaderboard         多服汇总排行榜
GET  /api/events              SSE 推送（事件名：status / server）
POST /api/backfill/:serverId  手动同步日志回填
GET  /health                  健康检查（不需要鉴权）
```

## 部署建议

局域网：

```env
HOST=0.0.0.0
PORT=3000
```

防火墙：

```text
TCP 3000       监控网页
TCP 25565      服务器 Minecraft（每个服一条）
UDP 25565      服务器 Query
TCP 25575      RCON（如果启用）
```

公网建议放 Nginx / Caddy / Cloudflare Tunnel 后面，并设置 `AUTH_TOKEN`。

## 项目结构

```text
src/
  server.js              HTTP 路由 + 调度
  lib/
    env.js               .env 加载
    util.js              通用小工具
    config.js            配置加载与归一化
    mcProtocol.js        Status Ping (TCP)
    mcQuery.js           Query 协议 (UDP)
    rcon.js              RCON 客户端 + TPS 解析
    processMon.js        系统/进程资源采集（批量化）
    logBackfill.js       日志解析与会话回填（带文件级缓存）
    playerStats.js       玩家时长统计 + 异步持久化
    auth.js              Bearer / query / cookie 鉴权
    sse.js               SSE 广播
public/
  index.html             仪表盘
  app.js                 渲染逻辑（增量 DOM、SSE 监听、主题切换）
  i18n.js                中英文字典
  styles.css             主题与布局
test/                    node:test 单元测试
```
