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
SERVERS=[{"id":"server1","name":"生存服","host":"127.0.0.1","port":25565,"queryEnabled":true,"queryHost":"127.0.0.1","queryPort":25565,"processPort":25565},{"id":"server2","name":"服务器2","host":"127.0.0.1","port":2000,"queryEnabled":true,"queryHost":"127.0.0.1","queryPort":2000,"processPort":2000}]
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
  "processName": "java"
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
