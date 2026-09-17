# 腾讯云部署

本文描述个人使用场景下的生产部署：审核后端运行在腾讯云 Docker 容器中，只监听服务器回环地址；浏览器扩展通过 SSH 本地端口转发访问后端。该方式不会把审核 API、材料数据或模型额度直接暴露到公网。

## 部署结构

```text
浏览器扩展
  -> 本机 127.0.0.1:8010
  -> Xshell SSH 本地端口转发
  -> 腾讯云 127.0.0.1:18110
  -> review-agent-service 容器 :8010
  -> DashScope API
```

浏览器扩展仍使用现有的 `http://127.0.0.1:8010`，因此不需要将服务器 IP、API Token 或模型密钥打包到扩展中。服务器端口 `18110` 仅绑定 `127.0.0.1`，公网无法直接访问。

## 前置检查

服务器至少需要 Docker Engine、Docker Compose v2、Git、curl，并需要留出约 1 GiB 内存和镜像构建空间。部署前执行：

```bash
free -h
df -h / /opt
docker compose version
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

若服务器 Swap 长期处于高占用，先确认现有容器的实际内存使用：

```bash
docker stats --no-stream
```

不要在未确认影响的情况下停止现有容器或全量升级系统。

## 首次部署

在服务器执行：

```bash
cd /opt
sudo git clone https://github.com/yangaobo0235/review-assistant.git
sudo chown -R ubuntu:ubuntu /opt/review-assistant
cd /opt/review-assistant
git switch main
cp review-agent-service/.env.example review-agent-service/.env
nano review-agent-service/.env
```

`.env` 中必须使用 DashScope OpenAI-compatible API 可用的 Key：

```env
DASHSCOPE_API_KEY=替换为真实Key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
```

不要把 `.env` 提交到 Git。若手里的 Key 只能调用 Anthropic-compatible 网关，它不能直接用于当前后端，需要更换为 DashScope OpenAI-compatible Key 或单独增加协议适配器。

启动服务：

```bash
cd /opt/review-assistant
bash deploy/server-deploy.sh
```

成功时健康检查返回：

```json
{"status":"ok"}
```

查看状态和日志：

```bash
docker compose -f docker-compose.server.yml ps
docker compose -f docker-compose.server.yml logs -f --tail=200 review-agent
```

## 配置 Xshell 本地端口转发

打开 `tencentCloud` 会话属性，进入 `连接 -> SSH -> 隧道`，新增本地转发规则：

```text
类型：Local（本地）
源主机：127.0.0.1
源端口：8010
目标主机：127.0.0.1
目标端口：18110
```

保存并重新连接 SSH。只要 Xshell 会话保持连接，本机访问下面地址就会转发到腾讯云容器：

```text
http://127.0.0.1:8010/health
```

如果本机正在运行 `start-agent.ps1`，需要先停止本地 Agent，否则 Xshell 无法占用本地 `8010` 端口。

在 PowerShell 中验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8010/health
```

## 构建和加载浏览器扩展

在开发机项目根目录执行：

```powershell
npm --prefix review-extension ci
npm --prefix review-extension run build
```

然后在 Chromium 浏览器扩展管理页启用开发者模式，选择“加载已解压的扩展程序”，目录为 `review-extension/dist`。扩展调用的仍是本机 `127.0.0.1:8010`，Xshell 负责把流量安全转发到服务器。

## 更新与回滚

更新前记下当前提交：

```bash
cd /opt/review-assistant
git rev-parse HEAD
git pull --ff-only origin main
bash deploy/server-deploy.sh
```

若新版本异常，使用上一步记录的提交创建临时回滚分支并重新部署：

```bash
git switch -c rollback/<日期> <旧提交SHA>
bash deploy/server-deploy.sh
```

确认修复后再切回 `main`。不要使用 `git reset --hard` 覆盖服务器上的未知改动。

## 停止服务

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml down
```

服务不使用数据库卷，停止容器不会影响 Git 仓库或 `.env`。模型 Key 只保存在服务器的 `review-agent-service/.env` 中。
