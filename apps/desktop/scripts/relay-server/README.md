# 中转站配置服务（relay-server）

TODO-074 的服务端一半：发布内置「中转站」的模型列表，并验证管理员密码。

**它不提供模型推理。** 推理走 Octopus 网关（`:8090`），这里只负责一个 JSON
文件的读与写。两者故意是两个进程：

| | 端口 | 职责 |
|---|---|---|
| Octopus 网关 | 8090 | 所有用户请求与 API Key 流经此处 |
| 本服务 | 18505 | 读/写一个模型列表文档 |

拆开的好处是这半边可以随时重启、甚至整个下线，而不影响任何一次推理；它的
blast radius 只有一个 JSON 文件，没有数据库句柄、没有上游凭据。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/relay-config.json` | 公开 | 客户端读的已发布文档 |
| GET | `/admin/verify` | Bearer | 200 / 401，解锁界面用它验证密码 |
| GET | `/admin/relay-config` | Bearer | 读当前发布文档 |
| POST | `/admin/relay-config` | Bearer | 覆盖发布（不保留历史） |
| GET | `/health` | 公开 | 存活探针 |

## 服务器端文件

```
/opt/mariocode-relay/server.mjs      本服务（从本目录部署）
/opt/mariocode-relay/relay.env       环境变量，chmod 600
/opt/mariocode-relay/data/relay-config.json   已发布文档
/etc/systemd/system/mariocode-relay.service
```

`relay.env`：

```
RELAY_ADMIN_TOKEN=<管理密码，>=16 位>
PORT=18505
RELAY_DATA_DIR=/opt/mariocode-relay/data
```

`RELAY_ADMIN_TOKEN` **就是**客户端解锁界面要输入的「管理员密码」。改密码 =
改这个文件 + `systemctl restart mariocode-relay`；客户端不需要重新发版。

### 端口为什么是 18505

服务器上 `ufw` 是白名单默认拒绝，**和云厂商安全组是两套独立规则**。18505 原本
就已在 ufw 放行且空闲，所以不需要改防火墙。换端口要同时改：
`relay.env` 的 `PORT` + 契约里的 `BUILTIN_RELAY_CONFIG_BASE_URL`（后者是发版级改动）。

## 部署

```bash
# 本机
base64 -w0 server.mjs | ssh root@<host> 'base64 -d > /opt/mariocode-relay/server.mjs'
base64 -w0 mariocode-relay.service | ssh root@<host> 'base64 -d > /etc/systemd/system/mariocode-relay.service'

# 服务器
systemctl daemon-reload && systemctl enable --now mariocode-relay
```

首次部署后，用 `BUILTIN_RELAY_FALLBACK_CONFIG` 灌一份初始文档：

```bash
pnpm --filter @mariocode/contracts build
node --input-type=module -e "import { BUILTIN_RELAY_FALLBACK_CONFIG as c } from './packages/contracts/dist/builtinRelay.js'; process.stdout.write(JSON.stringify({ version: 1, name: c.name, models: c.models }))" > seed.json
curl -X POST -H "authorization: Bearer $RELAY_ADMIN_TOKEN" -H 'content-type: application/json' \
  --data-binary @seed.json http://<host>:18505/admin/relay-config
```

不灌也能跑：客户端拉不到时用内置的 bundled 列表，只是管理员第一次打开面板会
看到「尚未推送过线上配置」。

## 加固说明

- **不要加 `MemoryDenyWriteExecute=true`。** V8 的 JIT 需要在可写/可执行之间切换
  页面，禁掉会让 node 启动时 `SIGTRAP` 崩溃（日志只显示 `code=dumped, status=5/TRAP`，
  完全看不出是沙箱选项导致的）。service 文件里已就地注释。
- 密码比较用 `timingSafeEqual`，且两边先 SHA-256 成定长再比，避免长度不等时抛异常
  泄漏长度信息。
- 同 IP 连续 8 次失败锁 60 秒（内存计数，重启即清）。
- 发布文档写入用 tmp + rename，读方不会看到半个文件。
- `validateConfig` 是**服务端独立实现**，不复用客户端 schema：根级只允许
  `version/updatedAt/name/models`，任何 `baseUrl` 之类的字段直接 400。这挡住的是
  「拿到管理密码的人把用户的 Key 引到别的地址」。
- 限流/鉴权失败一律返回同样的 `401 {error:"unauthorized"}`，不区分「没带头」和
  「密码错」。
