# 第三方声明

本仓库自己的代码按 [MIT](LICENSE) 授权。

`piano-studio-mac-migration/vendor/three/` 是 **three.js r170**（`REVISION = '170'`）的一份未修改的拷贝，包含它的 `build/` 和 `examples/jsm/`。这部分是第三方代码，**不在本仓库的 MIT 授权范围内**，沿用各自的许可证。

## three.js

- 许可证：MIT，Copyright © 2010-2024 three.js authors
- 项目：https://github.com/mrdoob/three.js
- 许可证全文：[third-party-licenses/three.js-LICENSE.txt](third-party-licenses/three.js-LICENSE.txt)

## three.js 示例库里附带的第三方库

位于 `vendor/three/examples/jsm/libs/`，随 three.js 一起提供，各有自己的许可证。下面只列已经核实过的。

| 库 | 许可证 | 依据 |
|---|---|---|
| draco | Apache-2.0 | 官方仓库 google/draco |
| basis（Basis Universal 转码器） | Apache-2.0 | 官方仓库 BinomialLLC/basis_universal |
| chevrotain | Apache-2.0 | 官方仓库 Chevrotain/chevrotain |
| rhino3dm | MIT | 官方仓库 mcneel/rhino3dm |
| UTIF.js | MIT | 官方仓库 photopea/UTIF.js |
| stats.js | MIT | 官方仓库 mrdoob/stats.js |
| ecsy | MIT | 官方仓库 ecsyjs/ecsy |
| lottie（lottie_canvas） | MIT | 官方仓库 airbnb/lottie-web |
| fflate | MIT | 文件头部声明 |
| lil-gui | MIT | 文件头部声明 |
| meshopt_decoder | MIT，Copyright (C) 2016-2022 Arseny Kapoulkine | 文件头部声明 |
| opentype.js | MIT | 文件头部声明 |
| surfaceNet.js | MIT | 文件头部声明 |
| potpack | ISC，Copyright (c) 2018, Mapbox | 文件头部声明 |
| ammo.js（ammo.wasm.js） | zlib | 文件头部声明 |

Apache-2.0 全文：[third-party-licenses/Apache-2.0.txt](third-party-licenses/Apache-2.0.txt)。

ktx-parse、mikktspace、mmdparser、motion-controllers、tween.js、zstddec 这几个库的文件头部没有写明许可证，请以它们各自项目的许可证为准。
