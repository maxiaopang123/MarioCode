# 中转站配置服务（relay-server）

TODO-074 的服务端一半：发布内置「中转站」的模型列表，并验证管理员密码。

**它不提供模型推理。** 推理走 mariogate 网关（`:8090`），这里只负责一个 JSON
文件的读与写。两者故意是两个进程：

| | 端口 | 职责 |
|---|---|---|
| mariogate 网关 | 8090 | 所有用户请求与 API Key 流经此处 |
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
| GET | `/admin/models` | Bearer | 读网关自己的模型清单（见下） |
| GET | `/health` | 公开 | 存活探针 |

## 管理员密码 = 网关管理员密码

**本服务自己不存任何密码。** 解锁界面输入的密码，就是 mariogate 面板
`admin` 账号的密码；本服务把它转发给网关的 `POST /api/v1/user/login`，只有
登录成功且返回 `role === "admin"` 才算通过。

- 改一边等于改两边：改网关密码，这里立刻跟着变，不用改配置、不用重启、不用发版。
- 密码不落盘、不进日志。换来的 JWT 只在内存里缓存 5 分钟（键是密码的
  SHA-256，从不存原文），让「验证 → 拉取 → 推送」只付一次 bcrypt 的代价。
- `/admin/models` 复用这个 JWT 当网关的 `auth` cookie 去读 `/api/v1/group/list`
  —— 模型清单**始终是走 HTTP 接口拿的**，本服务从不打开网关的数据库。
- 网关自己的登录限流（5 次 / 15 分钟，按 IP+用户名）比本服务的更严，被它拦住时
  原样透传成 `429 {error:"login_locked"}`。

## 服务器端文件

```
/opt/mariocode-relay/server.mjs      本服务（从本目录部署）
/opt/mariocode-relay/relay.env       环境变量，chmod 600
/opt/mariocode-relay/data/relay-config.json   已发布文档
/etc/systemd/system/mariocode-relay.service
```

`relay.env`：

```
PORT=18505
RELAY_DATA_DIR=/opt/mariocode-relay/data
RELAY_GATEWAY_BASE=http://127.0.0.1:8090
RELAY_ADMIN_USER=admin
```

改密码：去 mariogate 面板改 `admin` 的密码即可。本文件**不再有任何密码**，
所以也不再需要「改文件 + 重启」。

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

首次部署后，用 `BUILTIN_RELAY_FALLBACK_CONFIG` 灌一份初始文档（`$ADMIN_PW` 是
网关 `admin` 账号的密码）：

```bash
pnpm --filter @mariocode/contracts build
node --input-type=module -e "import { BUILTIN_RELAY_FALLBACK_CONFIG as c } from './packages/contracts/dist/builtinRelay.js'; process.stdout.write(JSON.stringify({ version: 1, name: c.name, models: c.models }))" > seed.json
curl -X POST -H "authorization: Bearer $ADMIN_PW" -H 'content-type: application/json' \
  --data-binary @seed.json http://<host>:18505/admin/relay-config
```

不灌也能跑：客户端拉不到时用内置的 bundled 列表，只是管理员第一次打开面板会
看到「尚未推送过线上配置」。

## 加固说明

- **不要加 `MemoryDenyWriteExecute=true`。** V8 的 JIT 需要在可写/可执行之间切换
  页面，禁掉会让 node 启动时 `SIGTRAP` 崩溃（日志只显示 `code=dumped, status=5/TRAP`，
  完全看不出是沙箱选项导致的）。service 文件里已就地注释。
- 密码比较交给网关（bcrypt + 它自己的登录限流），本服务只做「登录成功且
  `role === "admin"`」这一个判断；非管理员账号与密码错误返回同一个 401，不能用来
  探测账号是否存在。
- 同 IP 连续 8 次失败锁 60 秒（内存计数，重启即清）。
- 发布文档写入用 tmp + rename，读方不会看到半个文件。
- `validateConfig` 是**服务端独立实现**，不复用客户端 schema：根级只允许
  `version/updatedAt/name/models`，任何 `baseUrl` 之类的字段直接 400。这挡住的是
  「拿到管理密码的人把用户的 Key 引到别的地址」。
- 限流/鉴权失败一律返回同样的 `401 {error:"unauthorized"}`，不区分「没带头」和
  「密码错」。
