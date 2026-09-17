# Review Assistant 修改代码后重新部署完整流程

本文只记录从本地打包开始，到腾讯云更新完成的操作。没有测试、lint 和 Git 检查步骤。

## 固定部署信息

```text
腾讯云 IP：175.178.6.214
后端端口：18110
容器名称：review-agent-service
镜像名称：review-agent-service:main
服务器目录：/opt/review-assistant
上传目录：/home/ubuntu/review-agent-deploy
```

项目不是 Java 项目，没有 JAR。对应的后端发布文件是：

```text
review-agent-service-main.tar
```

插件发布文件是：

```text
review-extension-public.zip
```

## 一、本地重新打包

打开 PowerShell，进入项目：

```powershell
cd D:\fjkj\software\workspace\review-assistant
```

删除本地上次生成的发布文件，再创建输出目录：

```powershell
Remove-Item -LiteralPath .\.tmp\review-agent-service-main.tar -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath .\.tmp\review-extension-public.zip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath .\.tmp\docker-compose.server.yml -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force .\.tmp
```

### 1. 打包后端 Docker 镜像

先启动 Docker Desktop，确认左下角显示 `Engine running`。

执行：

```powershell
docker build --platform linux/amd64 `
  -t review-agent-service:main `
  .\review-agent-service
```

导出镜像 TAR：

```powershell
docker save `
  --output .\.tmp\review-agent-service-main.tar `
  review-agent-service:main
```

### 2. 打包公网插件

必须使用 `build:public`，这样插件才会连接腾讯云：

```powershell
npm --prefix review-extension run build:public
```

压缩插件：

```powershell
Compress-Archive `
  -Path .\review-extension\dist\* `
  -DestinationPath .\.tmp\review-extension-public.zip `
  -Force
```

复制服务器 Compose 文件：

```powershell
Copy-Item `
  -LiteralPath .\docker-compose.server.yml `
  -Destination .\.tmp\docker-compose.server.yml `
  -Force
```

查看生成结果：

```powershell
Get-Item `
  .\.tmp\review-agent-service-main.tar, `
  .\.tmp\review-extension-public.zip, `
  .\.tmp\docker-compose.server.yml |
  Select-Object FullName, Length, LastWriteTime
```

最终得到：

```text
D:\fjkj\software\workspace\review-assistant\.tmp\review-agent-service-main.tar
D:\fjkj\software\workspace\review-assistant\.tmp\review-extension-public.zip
D:\fjkj\software\workspace\review-assistant\.tmp\docker-compose.server.yml
```

## 二、上传到腾讯云

在 Xshell 登录服务器后执行：

```bash
mkdir -p /home/ubuntu/review-agent-deploy
```

使用 Xftp 把下面两个文件上传到 `/home/ubuntu/review-agent-deploy/`，选择覆盖服务器上的同名旧文件：

```text
.tmp/review-agent-service-main.tar
.tmp/docker-compose.server.yml
```

插件 ZIP 不需要上传服务器，它用于发给朋友。

上传完成后检查：

```bash
ls -lh /home/ubuntu/review-agent-deploy
```

确认 TAR 不再增长后再继续。当前 TAR 通常约 250 MB。

## 三、替换服务器后端

以下命令都在 Xshell 中执行。

进入服务器部署目录：

```bash
cd /opt/review-assistant
```

确认服务器正式密钥文件存在：

```bash
test -s review-agent-service/.env && echo '.env exists' || echo 'ERROR: .env missing'
```

必须显示：

```text
.env exists
```

更新时不要上传、覆盖或删除这个正式 `.env`。

### 1. 删除更早的回滚镜像

服务器只保留一个回滚版本。先删除上一次遗留的 `rollback` 标签：

```bash
docker image rm review-agent-service:rollback 2>/dev/null || true
```

这条命令只处理本项目的 `review-agent-service:rollback`，不会删除其他项目镜像。

### 2. 保存当前线上版本用于回滚

```bash
docker image inspect review-agent-service:main >/dev/null 2>&1 \
  && docker tag review-agent-service:main review-agent-service:rollback \
  || true
```

### 3. 安装新 Compose 文件

```bash
cp /home/ubuntu/review-agent-deploy/docker-compose.server.yml \
  /opt/review-assistant/docker-compose.server.yml
```

### 4. 加载新后端镜像

```bash
docker load -i \
  /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
```

查看镜像：

```bash
docker image ls review-agent-service
```

正常情况下会看到：

```text
review-agent-service   main
review-agent-service   rollback
```

### 5. 用新镜像重建容器

```bash
docker compose -f docker-compose.server.yml \
  up -d --no-build --force-recreate review-agent
```

旧容器会被 Compose 自动替换，不需要手工删除旧容器。

## 四、确认部署完成

查看容器状态：

```bash
docker compose -f /opt/review-assistant/docker-compose.server.yml ps
```

服务器内部检查：

```bash
curl http://127.0.0.1:18110/health
```

正常返回：

```json
{"status":"ok"}
```

查看后端日志：

```bash
docker compose -f /opt/review-assistant/docker-compose.server.yml \
  logs --tail=200 review-agent
```

自己电脑的 PowerShell 检查公网入口：

```powershell
curl.exe --noproxy "*" http://175.178.6.214:18110/health
```

正常返回：

```json
{"status":"ok"}
```

最后在真实业务页面使用插件完成一次审核。

## 五、发布新插件

需要发给朋友的文件：

```text
D:\fjkj\software\workspace\review-assistant\.tmp\review-extension-public.zip
```

朋友首次安装：

1. 把 ZIP 解压到固定目录。
2. Edge 打开 `edge://extensions/`，Chrome 打开 `chrome://extensions/`。
3. 开启开发人员模式。
4. 点击“加载解压缩的扩展程序”。
5. 选择包含 `manifest.json` 的目录。

朋友更新：

1. 用新 ZIP 内容覆盖之前的插件目录。
2. 打开浏览器扩展管理页。
3. 点击插件的“重新加载”。

## 六、部署成功后删除旧发布文件

确认后端和插件均正常后，删除服务器上传的 TAR：

```bash
rm -f /home/ubuntu/review-agent-deploy/review-agent-service-main.tar
```

TAR 已经通过 `docker load` 进入 Docker，删除上传文件不会影响正在运行的容器。

如果上传目录存在密钥中转文件，也删除：

```bash
rm -f /home/ubuntu/review-agent-deploy/review-agent.env
```

正式密钥文件必须保留：

```text
/opt/review-assistant/review-agent-service/.env
```

清理无标签的旧镜像层：

```bash
docker image prune -f
```

服务器最终只需要保留：

```text
review-agent-service:main
review-agent-service:rollback
```

检查：

```bash
docker image ls review-agent-service
```

不要删除 `interview-guide-*`、`refund-*` 等其他项目的容器和镜像。

## 七、出现问题时回滚

如果新后端上线后无法使用，把保留的回滚镜像重新设为 `main`：

```bash
docker tag review-agent-service:rollback review-agent-service:main
```

重新创建容器：

```bash
cd /opt/review-assistant
docker compose -f docker-compose.server.yml \
  up -d --no-build --force-recreate review-agent
```

检查：

```bash
curl http://127.0.0.1:18110/health
docker compose -f docker-compose.server.yml logs --tail=200 review-agent
```

如果只是新插件有问题，不需要动服务器。重新使用上一次的插件 ZIP，并在扩展管理页点击“重新加载”即可。

## 八、本地 IDEA 调试版

本地 IDEA 启动后端时，使用普通构建：

```powershell
npm --prefix review-extension run build
```

该插件连接：

```text
http://127.0.0.1:8010
```

发给朋友时必须重新执行：

```powershell
npm --prefix review-extension run build:public
```

该插件连接：

```text
http://175.178.6.214:18110
```
