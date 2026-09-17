# Review Assistant 腾讯云完整上线手册

本文用于代码修改后的重复上线。按照本文从上到下执行，可以完成本地验证、后端 Docker 镜像打包、公网插件打包、上传、服务器更新、验证、清理和回滚。

## 1. 当前部署信息

| 项目 | 当前值 |
| --- | --- |
| Git 分支 | `main` |
| 腾讯云公网 IP | `175.178.6.214` |
| SSH 用户 | `ubuntu` |
| 后端公网入口 | `http://175.178.6.214:18110` |
| 健康检查 | `http://175.178.6.214:18110/health` |
| 服务器部署目录 | `/opt/review-assistant` |
| 服务器上传中转目录 | `/home/ubuntu/review-agent-deploy` |
| 容器名 | `review-agent-service` |
| Docker 镜像 | `review-agent-service:main` |
| Compose 文件 | `/opt/review-assistant/docker-compose.server.yml` |
| 服务器密钥文件 | `/opt/review-assistant/review-agent-service/.env` |

这个项目不是 Java 项目，没有需要替换的 JAR。后端发布产物是 Docker 镜像 TAR；插件发布产物是 ZIP。更新时不要寻找或删除 JAR。

## 2. 判断需要发布哪些内容

- 修改了 `review-agent-service`、Python 依赖或 Dockerfile：重新打包并部署后端镜像。
- 修改了 `review-extension`：重新构建并分发公网插件 ZIP。
- 修改了 `docker-compose.server.yml`：重新上传 Compose 文件并重建容器。
- 不确定影响范围：执行本文完整流程，同时更新后端和插件。

公网插件和本地插件使用同一份代码：

```powershell
# IDEA 本地调试版，连接 http://127.0.0.1:8010
npm --prefix review-extension run build

# 发给朋友的公网版，连接 http://175.178.6.214:18110
npm --prefix review-extension run build:public
```

两个命令都会覆盖 `review-extension/dist`，发布时必须使用 `build:public`。

## 3. 本地发布前检查

打开 PowerShell：

```powershell
cd D:\fjkj\software\workspace\review-assistant
git status --short --branch
git branch --show-current
```

确认当前分支为 `main`，并确认没有意外的密钥、真实材料或无关文件准备提交。服务器密钥文件和本地 `deploy/review-agent.env` 不得提交到 Git。

记录当前提交，便于追踪发布版本：

```powershell
git rev-parse --short HEAD
```

## 4. 运行完整测试

后端：

```powershell
Push-Location review-agent-service
uv run ruff check app tests
uv run python -m compileall -q app
uv run pytest tests -q
Pop-Location
```

插件：

```powershell
npm --prefix review-extension test
npm --prefix review-extension run lint
```

检查 Git 差异格式：

```powershell
git diff --check
```

任意命令失败都应先修复，不要继续上线。

## 5. 清理并创建本地发布目录

发布文件统一生成到被 Git 忽略的 `.tmp`：

```powershell
Remove-Item -LiteralPath .\.tmp\review-agent-service-main.tar -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath .\.tmp\review-extension-public.zip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath .\.tmp\docker-compose.server.yml -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force .\.tmp
```

这些命令只删除本项目 `.tmp` 中上一轮发布产物，不会删除源码或服务器数据。

## 6. 构建并验证后端镜像

确保 Docker Desktop 左下角显示 `Engine running`，然后执行：

```powershell
docker build --platform linux/amd64 `
  -t review-agent-service:main `
  .\review-agent-service
```

检查镜像：

```powershell
docker image ls review-agent-service
```

本地启动临时容器验证：

```powershell
docker run --detach `
  --name review-agent-release-smoke `
  --publish 127.0.0.1:18010:8010 `
  review-agent-service:main
```

验证健康检查：

```powershell
curl.exe --noproxy "*" http://127.0.0.1:18010/health
```

应返回：

```json
{"status":"ok"}
```

验证后删除临时容器：

```powershell
docker stop review-agent-release-smoke
docker rm review-agent-release-smoke
```

如果上次异常中断导致同名测试容器仍存在，先确认它确实是本项目测试容器，再执行：

```powershell
docker rm -f review-agent-release-smoke
```

## 7. 导出后端镜像

```powershell
docker save `
  --output .\.tmp\review-agent-service-main.tar `
  review-agent-service:main
```

当前镜像 TAR 通常约 250 MB。检查文件：

```powershell
Get-Item .\.tmp\review-agent-service-main.tar |
  Select-Object FullName, Length, LastWriteTime
```

计算 SHA256，上传后用于校验：

```powershell
Get-FileHash .\.tmp\review-agent-service-main.tar -Algorithm SHA256
```

## 8. 构建公网插件 ZIP

必须使用公网构建命令：

```powershell
npm --prefix review-extension run build:public
```

压缩构建产物：

```powershell
Compress-Archive `
  -Path .\review-extension\dist\* `
  -DestinationPath .\.tmp\review-extension-public.zip `
  -Force
```

复制本次服务器配置：

```powershell
Copy-Item `
  -LiteralPath .\docker-compose.server.yml `
  -Destination .\.tmp\docker-compose.server.yml `
  -Force
```

检查三个发布文件：

```powershell
Get-Item `
  .\.tmp\review-agent-service-main.tar, `
  .\.tmp\review-extension-public.zip, `
  .\.tmp\docker-compose.server.yml |
  Select-Object FullName, Length, LastWriteTime
```

## 9. 使用 Xftp 上传服务器

在 Xshell 登录服务器，创建中转目录：

```bash
mkdir -p /home/ubuntu/review-agent-deploy
```

用 Xftp 将下面两个文件上传到 `/home/ubuntu/review-agent-deploy/`，选择覆盖旧文件：

```text
.tmp/review-agent-service-main.tar
.tmp/docker-compose.server.yml
```

插件 ZIP 不上传服务器，它用于发给朋友。

服务器检查上传结果：

```bash
ls -lh /home/ubuntu/review-agent-deploy
wc -c /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
sha256sum /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
```

服务器 SHA256 必须与本地 `Get-FileHash` 一致。文件还在上传时不要执行 `docker load`。

## 10. 更新服务器后端

以下命令在 Xshell 中执行。

确认当前服务状态：

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml ps
curl --fail http://127.0.0.1:18110/health
```

为当前线上镜像创建回滚标签。时间标签会打印出来，请记住：

```bash
rollback_tag="rollback-$(date +%Y%m%d-%H%M%S)"
docker tag review-agent-service:main "review-agent-service:${rollback_tag}"
echo "${rollback_tag}"
```

如果这是第一次部署、服务器还没有 `review-agent-service:main`，跳过上述三行。

安装本次 Compose 文件：

```bash
cp /home/ubuntu/review-agent-deploy/docker-compose.server.yml \
  /opt/review-assistant/docker-compose.server.yml
```

加载新镜像：

```bash
docker load -i \
  /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
```

确认新镜像存在：

```bash
docker image ls review-agent-service
```

确认正式密钥文件仍存在。正常更新绝对不要覆盖或删除它：

```bash
test -s /opt/review-assistant/review-agent-service/.env \
  && echo '.env exists' \
  || echo 'ERROR: .env missing'
```

若显示 `.env missing`，停止更新，重新创建密钥配置后再继续。

使用新镜像重建容器：

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml \
  up -d --no-build --force-recreate review-agent
```

## 11. 验证上线结果

查看容器：

```bash
docker compose -f /opt/review-assistant/docker-compose.server.yml ps
```

服务器内部验证：

```bash
curl --fail http://127.0.0.1:18110/health
```

查看最近日志：

```bash
docker compose -f /opt/review-assistant/docker-compose.server.yml \
  logs --tail=200 review-agent
```

本地 PowerShell 绕过代理验证公网：

```powershell
curl.exe --noproxy "*" http://175.178.6.214:18110/health
```

以上两处都应返回：

```json
{"status":"ok"}
```

最后安装本次公网插件，进行一次真实业务审核。健康检查成功只能证明服务启动，不能证明 DashScope Key、模型和完整审核流程都正常。

## 12. 分发或更新插件

公网插件位于：

```text
D:\fjkj\software\workspace\review-assistant\.tmp\review-extension-public.zip
```

朋友首次安装：

1. 解压 ZIP 到固定目录。
2. 打开 `edge://extensions/` 或 `chrome://extensions/`。
3. 开启开发人员模式。
4. 点击“加载解压缩的扩展程序”。
5. 选择包含 `manifest.json` 的解压目录。

朋友更新插件：

1. 用新 ZIP 内容覆盖原解压目录。
2. 打开扩展管理页。
3. 点击该扩展的“重新加载”。

如果希望用户完全不接触开发人员模式，需要后续发布到 Edge Add-ons 或 Chrome Web Store。

## 13. 上线成功后的安全清理

确认完整审核成功后，删除服务器上传的 TAR，释放磁盘。删除 TAR 不会删除已经加载的 Docker 镜像：

```bash
rm -f /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
```

如果中转目录曾上传过密钥文件，也删除中转副本：

```bash
rm -f /home/ubuntu/review-agent-deploy/review-agent.env
```

保留以下正式文件：

```text
/opt/review-assistant/docker-compose.server.yml
/opt/review-assistant/review-agent-service/.env
```

查看本项目所有镜像：

```bash
docker image ls review-agent-service
```

建议始终保留当前 `main` 和最近一个 `rollback-*`。确认新版本稳定后，再明确删除更旧的回滚镜像：

```bash
docker image rm review-agent-service:rollback-旧时间标签
```

不要执行不带镜像名的批量删除命令，也不要删除服务器上 `interview-guide-*`、`refund-*` 等其他项目镜像。

可选：删除没有标签且未被容器使用的悬空镜像层：

```bash
docker image prune -f
```

## 14. 新版本异常时回滚

查看回滚镜像：

```bash
docker image ls review-agent-service
```

将需要回滚的镜像重新标记为 `main`：

```bash
docker tag review-agent-service:rollback-时间标签 review-agent-service:main
```

重建容器：

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml \
  up -d --no-build --force-recreate review-agent
```

再次验证：

```bash
curl --fail http://127.0.0.1:18110/health
docker compose -f docker-compose.server.yml logs --tail=200 review-agent
```

如果仅插件有问题，不需要回滚服务器镜像；把旧插件 ZIP 重新解压并在扩展管理页重新加载即可。

## 15. 常用故障排查

查看容器状态：

```bash
docker ps --filter name=review-agent-service
```

查看端口：

```bash
sudo ss -lntp | grep 18110
```

查看日志：

```bash
docker logs --tail=200 review-agent-service
```

查看资源：

```bash
free -h
df -h / /opt
docker stats --no-stream
```

公网超时但服务器本机健康检查正常时，检查腾讯云轻量应用服务器防火墙是否允许 TCP `18110`，来源为 `0.0.0.0/0`。

浏览器显示 502，但 `curl.exe --noproxy "*"` 正常时，为本机代理添加 `175.178.6.214` 的 DIRECT/绕过规则。

## 16. 最短发布检查表

完整流程熟悉后，每次发布至少确认：

- [ ] 当前是 `main`，没有误提交密钥。
- [ ] 后端测试、插件测试和 lint 通过。
- [ ] Docker 镜像本地健康检查通过。
- [ ] 使用 `build:public`，不是普通 `build`。
- [ ] TAR 上传完成且 SHA256 一致。
- [ ] 更新前给旧镜像添加了 `rollback-*` 标签。
- [ ] 没有覆盖服务器正式 `.env`。
- [ ] 服务器内部和公网 `/health` 都正常。
- [ ] 用真实业务页面完成一次审核。
- [ ] 删除服务器上传 TAR，保留最近一个回滚镜像。
