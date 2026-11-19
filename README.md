# 存档编辑器（基岩版 / 网易版）

一个单文件网页。双击打开，就能读**网易加密的**基岩版存档，改玩家、计分板、世界设置，再导出成一个新的压缩包。

不需要 node、不需要安装、不需要联网，所有解析都在本机完成，存档不上传。

## 下载

到 [Releases](../../releases) 下载 `存档编辑器.html`，双击就能用。

仓库里的 `存档编辑器.html` 是**构建产物**，由 `_dev/` 下的源码生成；直接改它，下次构建会被覆盖。

## 能做什么

- **版本鉴别**：打开存档时只看 `db/CURRENT` 判断是网易基岩还是国际基岩（MCBE），并读出游戏版本（`lastOpenedWithVersion` → `MinimumCompatibleClientVersion` → `InventoryVersion`）
- **玩家**：昵称 / UID / 等级 / 生命 / 坐标 / 背包 / 权限；背包按 9 列排（主背包 27 + 快捷栏 9 + 护甲 5 + 末影箱 27），任意 NBT 字段都能改
- **计分板**：记分项列表、分数表、搜索、改分、清零、删项、新建项，还能把某一项设为侧边栏
- **世界设置**：`level.dat` 的全部开关，含游戏规则、超平坦、教育版、实验性功能、能力
- **全部数据**：几十万个键都能查；二进制键翻译成「区块 x, z · 维度 n」，不是一屏乱码
- **批量**：按搜索结果全选，一次改权限等级 / 跨世界读写
- **导出**：重建 LevelDB → 校验块尾 CRC 和 restart 数组 → 网易存档重新加密 → 打包下载。**自检不过就不出文件**

## 界面

七个页签，各自能改什么：

| 页签 | 内容 |
|---|---|
| 概览 | 版本鉴别、键总数 / 可解析 NBT 数 / 各类键分布、常用 NBT 键一键跳转 |
| 玩家 | 昵称 / UID / 等级 / 生命 / 坐标 / 维度 / 朝向 / 饥饿 / 氧气 / 经验 / 游戏模式 / Tags / 模组数据；背包 9 列格子（点格子改物品 ID、数量、损伤值）；下方完整 NBT 树任意字段可改；「只看有快建」只列快建等级 > 0 或开了跨世界读写的玩家 |
| 模组 | 自动识别 `scriptData` 里所有模组（不只快建），列每个模组的玩家数、字段，点开看具体取值 |
| 世界 | `level.dat` 全部设置，左侧 8 个子页：世界信息 / 游戏玩法 / 游戏规则（38 条，分五组）/ 教育版 / 超平坦 / 实验性功能 / 能力 / 高级（115 个顶层键） |
| 计分板 | 记分项列表 → 分数表（按分排序、可搜索昵称或分数）；改分、删单条、清零、删整项、新建项、设为侧边栏；「加玩家」按顶层 `LastUniqueID + 1` 发号，没有这个键的存档直接拒绝，不硬凑 |
| 全部数据 | 几十万个键全部可查；能解析的显示成 NBT 树（可改），二进制键显示十六进制；区块 key 翻译成「区块 x, z · 维度 n · tag 0x2b」 |
| 批量 | 玩家列表可勾选（支持按搜索条件全选），一次改快建等级 / 跨世界读写 / 权限等级，只改勾中的那些人 |

导出永远是「重建数据库 → 自检 → 重新加密（网易存档）→ 打包 zip」。

## 用法

1. 双击 `存档编辑器.html`
2. 选「选择压缩包」（`.zip` / `.mcworld` / `.mctemplate`），或「选择世界文件夹」（含 `db/` 的整个目录）
3. 改完点右上角「导出存档」，下载一个新的 zip，解压覆盖原世界

浏览器不能直接写存档目录，所以导出的是新 zip，这一步得手动做。想直接写回存档，用配套的 node 工具（不在本仓库）。

## 支持的存档

| 类型 | 说明 |
|---|---|
| 网易基岩 | `.ldb` / `MANIFEST` / `CURRENT` 是加密的，在内存里解密后读取，不改原文件 |
| 国际基岩（MCBE） | 标准 LevelDB，直接读 |
| 打包形式 | `.zip`、`.mcworld`、`.mctemplate`、整个世界目录 |

## 浏览器

Chrome / Edge 88+、Safari 16.4+、Firefox 113+。手机上建议用「选择压缩包」——「选文件夹」（`webkitdirectory`）在多数手机浏览器里不支持。

## 已知限制

- 导出是**重建**数据库（逻辑内容与原库一致），第一次替换前请先备份原存档
- 700 MB 以上的存档别用手机打开，内存不够会崩
- 游戏正开着写盘时，个别 `.ldb` 可能读不了，工具会列出来并跳过；完整读取请先退出游戏

## 仓库结构

```
存档编辑器.html          构建产物，也是 release 附件
_dev/                    源码，改这里
├── template.html        页面骨架 + 全部 CSS
├── items.js             物品 ID → 中文名（由 _zh_CN.lang 生成，别手改）
├── core.js              NBT、LevelDB、网易加解密、zip 解包打包
├── pipeline.js          打开 → 定位 db → 解密 → 解析 → 导出
├── app.js               界面逻辑：标签页、玩家表、计分板、level.dat、版本鉴别
├── build.js             把上面五个内联成一个 HTML
├── lvcheck.js           LevelDB 严格校验器（块尾 CRC + restart 数组）
├── test-core.js         读库 → NBT 往返 → 重建 → 用 leveldb 读回比对
├── test-pipeline.js     端到端：开 zip → 解析 → 改玩家 → 导出
├── test-level.js        level.dat 编辑闭环
├── test-scoreboard.js   计分板增删改闭环
├── test-addplayer.js    计分板加玩家的发号逻辑
├── test-keylabel.js     二进制 key → 「区块 x,z · 维度 n」
├── test-leveldb-format.js  导出产物的 LevelDB 格式验收
├── _zh_CN.lang          Mojang bedrock-samples 的简体中文语言文件
└── _browser/            CDP 驱动的浏览器自测（4 个脚本，见下文「自测」）
```

## 仓库里的两个隐藏文件

| 文件 | 作用 |
|---|---|
| `.gitignore` | 规定哪些文件不进仓库：`*.key`、截图、`node_modules` |
| `.gitattributes` | 行尾统一 LF；`png` / `zip` 标成二进制，跨平台不会改坏 |

`.git/` 是 git 自己的目录（本地历史），由 `git init` 生成，不提交。

## 构建

```bash
cd _dev
node build.js
```

输出到上一级 `存档编辑器.html`，末尾会打印体积和「外部依赖：无」。

`build.js` 只做字符串替换：把 `template.html` 里的 `<!--INCLUDE:xxx.js-->` 换成内联 `<script>`。所以：

- 改界面 → `template.html`
- 改逻辑 → `core.js` / `pipeline.js` / `app.js`
- 新增文件 → 同时改 `build.js` 的数组和 `template.html` 的 include 占位

## 自测

纯 node，无外部依赖：

```bash
cd _dev
node test-core.js          # 内核
node test-pipeline.js      # 端到端
node test-scoreboard.js    # 计分板
node test-level.js         # level.dat
```

浏览器里的检查（需要本机 Edge，路径会自动探测，也可以用 `EDGE` 环境变量指定）：

| 脚本 | 用途 |
|---|---|
| `smoke.js` | 冒烟：打开存档 → 切六个页签 → 收集 JS 异常 |
| `ident-test.js` | 端到端：塞存档 → 等解析完成 → 截概览页 |
| `check-overflow.js` | 找出横向溢出的元素（手机窄屏排查） |
| `shot.js` | 按指定设备尺寸整页截图 |

```bash
cd _dev/_browser
node smoke.js <存档.zip 绝对路径>
node ident-test.js 1280 800 <存档.zip> out.png
node check-overflow.js file:///.../存档编辑器.html
node shot.js file:///.../存档编辑器.html out.png 390
```

`lvcheck.js` 是导出前的严格校验器，独立于自己的解析器 —— **自己读回来不算验证**，顺序扫描既不算 CRC 也不走 restart 二分。

## 许可

本仓库暂未附许可证，作者确认后在此补充。
