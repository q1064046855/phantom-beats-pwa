# PHANTOM BEATS · 手机版（PWA）

把电脑上的「幻彩律动」音乐可视化器变成可在**安卓手机 Chrome 一键安装到主屏**的 App（无需 Android SDK、无需 .apk）。

> 已适配手机：触屏自动隐藏「系统音频」（手机上不可用），默认「演示」模式，打开即见动画。

## 手机上能怎么听？
- **演示**：自带合成音，免权限，立刻看到动画。
- **麦克风**：授权后跟着环境声 / 手机外放律动（戴耳机不行）。
- **本地文件**：点「本地文件」选手机里一首歌播放并可视化。
- ⚠️ **系统音频**：安卓禁止第三方 App 抓取别的 App/系统正在放的声音，所以手机上这个模式不可用（已隐藏）。这是平台限制，不是 bug。

## 安装方式（二选一）

### 方式 A：GitHub Pages（推荐，最稳，约 2 分钟）
#### 最简单：一键脚本（仓库已 git 初始化并提交）
1. 在 GitHub 建一个 **Personal Access Token（classic）**：
   GitHub 右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic)
   → Generate new token → 勾选 **repo**（含 public_repo / pages:write）→ Generate → 复制以 `ghp_` 开头的令牌。
2. 在本文件夹（`phantom-beats-pwa`）打开终端（PowerShell），运行：
   ```powershell
   .\deploy.ps1 -User 你的GitHub用户名 -Token 你的PAT
   ```
   脚本会**自动**建公开仓库、推送 main 分支、开启 Pages，并打印访问地址。
   （令牌仅在本地使用，不会写入任何提交的文件；不要在聊天里粘贴令牌。）
3. 等 1–2 分钟 Pages 构建完，用**手机 Chrome** 打开 `https://<用户名>.github.io/phantom-beats-pwa/`，
   点 ⋮ → **「添加到主屏幕」**即安装。

#### 或手动操作
1. 在 GitHub 新建一个**空**仓库（如 `phantom-beats-pwa`，不要勾 README）。
2. 终端里：
   ```powershell
   git remote add origin https://<USER>:<TOKEN>@github.com/<USER>/phantom-beats-pwa.git
   git branch -M main
   git push -u origin main
   ```
3. 仓库 Settings → Pages → Source 选 `main` 分支根目录 → Save。
4. 等一两分钟，手机 Chrome 打开 `https://<用户名>.github.io/phantom-beats-pwa/`，点 ⋮ → **「添加到主屏幕」**。

### 方式 B：本地 HTTPS 临时服务器（无需外部账号，今天就能用）
> 自签证书会被 Chrome 报「不安全」——点「高级 → 继续访问」即可，这仍属于安全上下文，可正常安装。
1. 电脑上确保装了 Node.js。在本目录运行：
   ```
   node serve-https.js
   ```
2. 终端会打印类似 `https://192.168.x.x:8443` 的地址（就是你电脑的局域网 IP）。
3. **手机连同一个 WiFi**，浏览器打开这个 https 地址，接受证书警告。
4. 点 ⋮ → **「添加到主屏幕」**即安装。
5. 用完后 `Ctrl+C` 关掉服务器即可。

## 重新生成资源（可选）
- 图标：`node gen_pwa_icons.js`（生成 `icon-192.png` / `icon-512.png` / `icon-maskable-512.png`）。
- 自签证书：`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -config openssl.cnf`（已附带 `openssl.cnf`）。

## 文件清单
```
index.html              页面 + PWA 注册 + 移动端适配
app.js                  可视化引擎（镜像波形三频律动 / 星空穿行 / 配色随音量冷暖）
manifest.webmanifest    PWA 清单（名称、图标、全屏）
sw.js                   Service Worker（缓存外壳，支持离线）
icon-192.png / icon-512.png / icon-maskable-512.png   图标
serve-https.js          本地 HTTPS 临时服务器（方式 B 用）
cert.pem / key.pem      自签证书（方式 B 用）
openssl.cnf            证书配置
gen_pwa_icons.js        图标生成脚本
```
