# Piano Studio Mac Migration

这是一个可以在新 Mac 上继续开发的三角钢琴 3D 浏览器项目。项目包含程序化建模、实时渲染、电脑键盘/MIDI 弹奏、录制导出，以及本地 Accurate Salamander 精修版钢琴采样。

## 音源

迁移包只保留一个音源：`Accurate Salamander（精修版）`。

- 音频和 SFZ 资料：`samples/AccurateSalamander/`
- 运行时清单：`samples/accurate.json`
- 可用音源索引：`samples/index.json`
- `samples/index.json` 只登记 `accurate`，不要从旧电脑复制其他音源目录或下载缓存。

这个音源基于 Alexander Holm 的 Salamander Grand Piano 原采样，由 Accurate-Salamander Project（cyamauch）重制，包含重新调音、降噪、力度曲线重映射和低音区衰减修正。项目说明和清单中保留了来源、署名和 CC-BY 3.0 授权信息。

## 新 Mac 安装

先安装 Node.js（建议当前 LTS），然后双击 `start.command`。首次运行会自动安装依赖、重新构建页面并在默认浏览器中打开。也可以在本目录执行：

```bash
npm install
npm run start
```

浏览器打开：

```text
http://127.0.0.1:8137
```

采样音源通过 HTTP 按需读取，因此使用 `start.command` 或 `npm start`。`npm start` 会启动项目内置 Node 静态服务器，不依赖 Python。项目也保留了已生成的 `piano.js`；直接双击 `index.html` 可使用内置合成音源，运行源码开发时通过本地服务器打开 `dev.html`。

## 开发与构建

- 源码入口：`src/main.js`
- 音频采样引擎：`src/audio/sampler.js`
- 3D、交互和录制代码：`src/`
- 开发和测试工具：`tools/`
- Three.js 本地依赖：`vendor/three/`

修改 `src/` 后重新生成可双击打开的单文件版本：

```bash
node tools/build.mjs
```

不要运行 `npm run samples`。这个命令会重新下载普通 Salamander 音源，迁移包已经带有唯一需要的精修版音源。

## 精修版音源测试

先运行 `start.command` 或 `npm start` 启动服务器，再开一个终端执行：

```bash
node tools/sampletest.mjs
LIB=accurate node tools/sampletest.mjs
```

在 macOS 的默认 shell 中，`LIB=accurate node tools/sampletest.mjs` 会把环境变量传给当前命令。测试会验证索引、采样加载、按键发声、松键采样和延音踏板行为。

## 目录说明

```text
index.html                  可直接打开的构建版页面
dev.html                    源码开发页面
piano.js                    esbuild 生成的单文件构建产物
src/                        可读、可修改的项目源码
tools/                      构建、测试和诊断脚本
vendor/three/               离线 Three.js 依赖
samples/accurate.json       Accurate 运行时清单
samples/index.json          仅包含 Accurate 的音源索引
samples/AccurateSalamander/ 精修版采样和原始映射资料
package.json                npm 脚本和依赖声明
package-lock.json           npm 依赖锁定文件
```

`node_modules/` 没有随包迁移。新 Mac 上执行 `npm install` 会按 `package-lock.json` 重新安装依赖。

## 授权与署名

Accurate Salamander 沿用原 Salamander 采样的 CC-BY 3.0 授权。原采样作者为 Alexander Holm；精修工作来自 Accurate-Salamander Project（cyamauch）。详细信息见 `README.md`、`samples/AccurateSalamander/README.txt` 和 `samples/accurate.json`。
