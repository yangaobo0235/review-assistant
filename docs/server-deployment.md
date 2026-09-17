# 腾讯云部署

本文描述朋友试用场景下的部署方式：审核后端运行在腾讯云 Docker 容器中，并通过服务器公网端口 `18110` 提供服务；朋友安装构建好的浏览器扩展后可以直接使用，无需安装 Docker、Xshell、Tailscale 或本地 Agent。

## 部署结构

```text
浏览器扩展
  -> http://175.178.6.214:18110
  -> review-agent-service 容器 :8010
  -> DashScope API
```

服务器的 `80` 端口继续提供已有的 AI Interview 网站，本项目使用独立的 `18110` 端口，二者互不影响。

> 当前入口使用 HTTP，浏览器会标记为“不安全”。它适合可信朋友使用非敏感或脱敏材料进行试用；若处理真实敏感材料或扩大使用范围，应改为备案域名、HTTPS、鉴权和限流。

## 服务器前置条件

服务器需要 Docker Engine、Docker Compose v2，并在腾讯云安全组入站规则中放行：

```text
协议：TCP
端口：18110
来源：0.0.0.0/0
```

如果能够确定朋友的公网出口 IP，建议把来源缩小到这些 IP。

## 使用本地构建的镜像

开发机生成部署镜像：

```powershell
docker build --platform linux/amd64 -t review-agent-service:main .\review-agent-service
New-Item -ItemType Directory -Force .\.tmp
docker save --output .\.tmp\review-agent-service-main.tar review-agent-service:main
```

通过 Xftp 将以下文件上传到服务器 `/home/ubuntu/review-agent-deploy/`：

```text
.tmp/review-agent-service-main.tar
docker-compose.server.yml
```

服务器执行：

```bash
sudo mkdir -p /opt/review-assistant/review-agent-service
sudo chown -R ubuntu:ubuntu /opt/review-assistant
cd /opt/review-assistant
docker load -i /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
cp /home/ubuntu/review-agent-deploy/docker-compose.server.yml /opt/review-assistant/
```

## 配置模型密钥

在服务器创建 `/opt/review-assistant/review-agent-service/.env`：

```bash
cd /opt/review-assistant
nano review-agent-service/.env
```

内容：

```env
DASHSCOPE_API_KEY=替换为真实DashScope密钥
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
```

保存后限制权限：

```bash
chmod 600 review-agent-service/.env
```

密钥不要写入 Docker 镜像、Git 仓库或发给插件使用者。

## 启动和验证

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml up -d --no-build review-agent
docker compose -f docker-compose.server.yml ps
curl http://127.0.0.1:18110/health
```

健康检查应返回：

```json
{"status":"ok"}
```

在开发机验证公网入口：

```powershell
Invoke-RestMethod http://175.178.6.214:18110/health
```

## 构建和分发浏览器扩展

扩展已配置为直接请求 `http://175.178.6.214:18110`：

```powershell
npm --prefix review-extension ci
npm --prefix review-extension run build
Compress-Archive -Path .\review-extension\dist\* -DestinationPath .\.tmp\review-extension.zip -Force
```

将 `review-extension.zip` 发给朋友。朋友解压后，在 Chromium 浏览器扩展管理页启用开发者模式，选择“加载已解压的扩展程序”，选择解压后的目录即可。之后无需运行其他程序。

## 查看日志与停止服务

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml logs -f --tail=200 review-agent
docker compose -f docker-compose.server.yml down
```
