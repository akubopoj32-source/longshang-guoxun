# 陇上果巡

面向庆阳苹果果园的智能巡查记录助手。巡查员提交文字和照片，工作台整理字段、追问缺项并保存原始依据。记录可由人工复核和导出。

## Windows 桌面客户端

解压构建包后，双击 `LongshangGuoxun.exe`。客户端自带运行时，启动时会拉起本机巡查服务。请保留可执行文件旁的资源目录。桌面记录保存在 `%APPDATA%\陇上果巡\records.sqlite3`。

从源代码运行桌面端，需要 Node.js 22.12 或更新版本及 Python 3.10 或更新版本。

```powershell
cd desktop
npm ci
npm start
```

在 Windows 上，从 `desktop/` 目录构建可分发目录：

```powershell
python -m pip install PyInstaller
npm run build:win
```

输出位于 `dist/LongshangGuoxun-win32-<架构>/`，分发时提供整个目录。要沿用此前网页模式的记录，可关闭两种运行方式后，将 `.orchard/records.sqlite3` 复制到桌面数据目录。若目标已有记录，请先备份。开发或测试也可用 `ORCHARD_DESKTOP_DB` 指定独立的数据库文件。

## 微信小程序联调

小程序负责填写现场描述、录音转写、拍照或选图、按提示补充字段及提交复核。桌面客户端复核同一条记录，退回意见可在手机刷新后查看。开发版通过同一台电脑上的巡查服务共享记录。

手机端可以完成的工作：

- 首页按状态筛选（全部、草稿、待复核、已复核、已退回），按点位、任务类型或记录编号搜索，顶部可直接回到「上次的巡查记录」。
- 详情页按字段列出证据原话，点开可跳到对应的原始证据轮次和照片；被更正过的字段会同时列出旧原话并标注已被取代。
- 记录待复核时可就地逐项复核：确认现值、人工更正（必须填写更正依据）或标记为待核实。
- 导出复查单（Markdown）或 JSON，也可复制复查单文本。文件分享在模拟器等环境不可用时自动改为复制到剪贴板。

1. 安装[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)，扫码登录后导入仓库的 `miniprogram/` 目录。在导入窗口填写自己有开发权限的小程序 AppID，本地编译也可以选择「测试号」。
2. 在项目根目录的 PowerShell 启动共享服务。示例端口为 `8875`，数据保存在独立的联调数据库中。

   ```powershell
   $env:ORCHARD_LOCAL_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(24))"
   $env:ORCHARD_LOCAL_TOKEN
   python app.py --host 0.0.0.0 --port 8875 --db 'local/小程序联调/records.sqlite3'
   ```

3. 电脑模拟器的服务地址可填 `http://127.0.0.1:8875`。真机联调时让手机与电脑连接同一可信 Wi-Fi，在电脑运行 `ipconfig` 查找 Wi-Fi 网卡的 IPv4 地址。若地址是 `192.168.1.10`，小程序里就填 `http://192.168.1.10:8875`。令牌使用上一步生成的值。如果模拟器拦截本地请求，可在开发者工具的本地设置里临时关闭域名校验。真机连不上时，检查 Windows 防火墙是否允许 Python 在专用网络接收连接。[微信小程序局域网文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/mDNS.html)
4. 关闭已经运行的独立桌面客户端。在项目根目录另开一个 PowerShell，填入同一个令牌并启动桌面客户端。首次从源码运行桌面端需要先在 `desktop/` 执行 `npm ci`。

   ```powershell
   $env:ORCHARD_LOCAL_TOKEN = '粘贴同一个联调令牌'
   $env:ORCHARD_SHARED_URL = 'http://127.0.0.1:8875'
   cd desktop
   npm start
   ```

5. 在小程序里新建诱捕监测记录，输入模拟描述并选一张示意图。处理输入、补充追问并提交复核。桌面端点击「刷新记录」，用手机详情页的记录编号定位同一条记录。桌面端填写意见并退回后，在小程序详情页点击「刷新」。

联调使用模拟材料，令牌只填在本机和测试小程序中。联调结束后可在服务窗口按 `Ctrl+C` 停止监听。正式发布需要配置 HTTPS 请求域名、用户身份验证和访问权限。[微信小程序网络文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)

## Docker 部署

```powershell
docker compose up --build -d
docker compose ps
```

访问 [容器工作台](http://127.0.0.1:8765)。Compose 默认仅向本机发布端口，巡查数据保存在命名卷 `records` 中。`docker compose down` 可停止部署并保留数据卷。端口冲突时可在启动前设置 `ORCHARD_PORT`。容器部署与桌面客户端使用独立的数据位置，默认按本机演示方式部署。

如果 Docker Hub 拉取 Python 基础镜像超时，可在启动前指定 Docker 官方 Python 镜像的 ECR Public 地址。

```powershell
$env:ORCHARD_PYTHON_IMAGE = 'public.ecr.aws/docker/library/python:3.12-slim'
docker compose up --build -d
```

## 巡查数据库备份

新版后端首次打开旧库时，会在同一目录生成 `*.before-v1-*.sqlite3` 备份，再迁移列表摘要。电脑端和小程序继续使用原有记录接口。共享服务运行时可用 SQLite 的在线备份生成一致的副本。

```powershell
python app.py --db 'local/wechat-simulator/records.sqlite3' --backup 'local/backups/records-2026-11-13.sqlite3'
```

将 `--db` 指向实际使用的库，`--backup` 填写新文件路径。恢复时先停止服务，再用 `--db` 指向备份副本启动。数据库开启了 WAL，在线备份请使用上述命令。

## 浏览器调试

需要 Python 3.10 或更新版本。Python 服务无需安装第三方运行依赖。

```powershell
python app.py
```

打开 [本地工作台](http://127.0.0.1:8765)。记录保存在本地 `.orchard/records.sqlite3`，默认只监听本机。左侧默认打开待复核队列，显示各状态数量，支持按任务和更新日期筛选，也可搜索点位、任务类型或记录编号。界面可见时每 15 秒尝试刷新队列，可随时点击「刷新」。

记录顶部显示已记录的字段数、待核实字段和下一步。录入区显示本轮是否已保存。图文模型处理失败时，可保留本轮文字和照片并用本地规则保存。桌面端的「连接状态」显示本地库或共享库、服务地址、提取方式和最近刷新时间，也可在此重新连接。若保存响应丢失，先点击录入区的「同步记录版本」核对结果。

### 跑通演示

1. 新建「诱捕监测」记录。输入「三号点看到两只疑似虫体」，可附一张有权使用的图片。
2. 回答「今天上午，刚才说错了，是五号点」。核对当前点位和历史证据，第 1 轮的「三号点」原话标注为已被更正。没有图片时可以补充「没拍照」。
3. 提交复核。电脑端点选字段可关联原话和照片，小程序端可点开对应轮次的原图。两端均可逐字段确认、更正或标记待核实。电脑端可确认整条记录或退回补拍，小程序刷新后会显示复核意见。
4. 确认后可导出含原始证据的 JSON、Markdown 复查单，或预览含照片的打印版。Windows 桌面端可从预览窗口另存 A4 PDF。

在微信小程序里，点击「开始录音」，说完后点击停止。配置语音转写后，转写文字会填入描述框，供巡查员核对再保存。转写失败时可在当前页面重试或手动补充文字，记录保存的是核对后的文字。

### 配置图文模型

默认使用本地规则演示，可以留存并复核原图。要启用视觉提取和基于图片质量的补拍追问，配置支持图文输入的 Chat Completions 兼容服务，然后重启。

```powershell
$env:ORCHARD_MODEL_URL = 'https://your-model-provider.example/v1/chat/completions'
$env:ORCHARD_MODEL = '服务商提供的视觉模型标识'
$env:ORCHARD_MODEL_KEY = '本机的服务密钥'
python app.py
```

桌面客户端可从同一个 PowerShell 窗口启动，继承这些环境变量。Docker Compose 也会读取这些变量。启用后，本轮文字、图片及用于提取的当前字段将发送到配置的模型服务。仅使用获准传输的材料，密钥通过本机环境变量配置。当前复核视图用于本地原型演示，巡查与复核共用工作台。

同一组变量也用于语音转写。录音以 Chat Completions 的 `input_audio` 内容块发送到已配置的服务。`/api/config` 返回的 `voice` 表示转写接口已有模型配置，实际音频支持请用一段模拟录音验证。

巡查员原话与照片可见线索分别保存。诱捕监测中，当同轮有明确口述数量且模型认为照片完整、可计数时，数量不同会列入「图文证据待核对」，并关联原话及原图。局部或模糊图优先进入补拍或待核对流程。模型服务失败时，本轮输入保留在表单中，可重试或选择「用规则保存本轮」。规则模式会保存原图，视觉识别留待后续核对。

明确更正字段后，旧值与原话保留在修订和证据历史中。图文数量告警只使用当前数量对应的同轮有效证据。

## 巡查知识库

在电脑端点击「知识库」，可查询「诱捕监测需要记录哪些字段？」或「2024 年庆阳计划布设多少苹果蠹蛾监测点？」。界面会显示资料摘要、章节和原文链接。配置图文模型后，服务会把问题和检索到的段落发送给模型，生成带出处的回答。模型不可用时，可直接查看本机检索结果。

在记录中也可选中字段后点击「查字段资料」。工作台会填入可编辑的通用问题，例如照片覆盖不足时如何补拍，点击「查询资料」后才发送该问题。关闭知识库后可接着复核原字段。

资料维护在 [knowledge.json](orchard_workbench/knowledge.json)。目前收录 21 份资料、38 个可检索段落，覆盖庆阳果业、诱捕监测、果园异常、灾后巡查、采收贮藏和项目复核。每条资料包含标题、原文链接、段落编号、章节、关键词和摘要。历史计划与年度指导保留年份和适用范围，苹果蠹蛾监测标准标明查阅时的状态。修改后重启服务即可更新。

## 在本机测试巡查规则

在项目根目录执行以下命令，检查工作台如何提取巡查字段、追问缺项和处理更正。测试在本机运行，无需联网或配置模型服务。

```powershell
python -m unittest discover -s tests
python -m evaluation.run --mode fixture --input multimodal --output 'local/评测结果/模拟图文.json'
python -m evaluation.run --mode fixture --input text --output 'local/评测结果/模拟纯文本.json'
python -m evaluation.run --mode rules --input multimodal --output 'local/评测结果/规则图文.json'
```

`python -m unittest` 覆盖证据规则和语音转写：口述与照片数量差异、局部图不参与比对、人工复核保留原依据、更正后保留旧原话、重复更正不产生重复证据，以及语音格式校验和各类转写失败的提示文案。这些用例不访问网络，转写相关用例用替身服务验证失败分支。

`fixture` 模式使用本地文字规则和案例中预先写好的视觉响应，可模拟有限视野、数量差异及异常候选字段。`rules` 模式验证实际的本地规则和照片留存流程。纯文本输入会省略图片。两种模式都在本地运行，结果用于开发验收。真实视觉效果应在接入模型后单独实测。

在 [案例文件](evaluation/cases.json) 中填写任务、输入步骤和预期结果。`expect` 适用于所有运行方式，`expect_by_variant` 可针对 `fixture-multimodal` 等运行方式覆盖预期值。`evaluation/fixtures/` 中的图片是团队自制示意图，用于模拟不同图像条件。输出 JSON 记录每步的字段、追问、修订历史、待核对项和逐项断言，也记录所用案例文件和图片的 SHA-256。断言失败时仍会输出结果，命令以退出码 1 结束。

## 参赛资料

- [项目策划书](docs/陇上果巡项目策划书.md)
- [策划书打印版](docs/陇上果巡项目策划书_打印版.pdf)
- [策划书导师审阅稿](docs/陇上果巡项目策划书_导师审阅稿.pdf)
- [大赛方案](references/2026年中国算谷人工智能大赛方案.pdf)
- [大赛官方参赛规则](https://cvaic.qyvtc.cn/rules)

## 开发协作

电脑端和小程序端分别开发。每次改动随代码提交一份开发记录，便于合并时核对接口、依赖和验证结果。 [开发记录与模板](docs/development/README.md)

## 目录说明

| 路径 | 内容 |
|---|---|
| `app.py` | 本地工作台启动入口 |
| `desktop/` | Electron 桌面入口和 Windows 打包脚本 |
| `miniprogram/` | 微信小程序：录入、语音采集、证据查看、逐项复核与导出 |
| `Dockerfile`、`compose.yaml` | 服务镜像与本地容器部署 |
| `orchard_workbench/` | 服务端、巡查规则、语音转写边界与网页 |
| `orchard_workbench/orchard.py` | 任务字段、提取规则、证据合并与复核状态机 |
| `orchard_workbench/voice.py` | 语音格式校验与转写调用，失败时给出可操作提示 |
| `tests/` | 证据规则与语音转写的单元测试 |
| `evaluation/` | 离线评测入口、开发案例和自制示意图 |
| `docs/` | 项目策划书、可打印版本和开发记录 |
| `references/` | 赛事方案及庆阳果业公开资料 |
| `local/` | 本机报名材料、快捷方式和测试产物，Git 忽略 |
| `.orchard/` | 本机运行数据，Git 忽略 |

## 庆阳果业参考资料

[已归档的资料文件](references/庆阳果业参考资料)和原始来源如下。

- [庆阳市智慧果业实施意见](https://zgqingyang.gov.cn/Upload/main/pdf/2025/03/20/%E5%BA%86%E9%98%B3%E5%B8%82%E4%BA%BA%E6%B0%91%E6%94%BF%E5%BA%9C%E5%8A%9E%E5%85%AC%E5%AE%A4%E5%85%B3%E4%BA%8E%E4%BE%9D%E6%89%98%E6%95%B0%E5%AD%97%E4%BA%A7%E4%B8%9A%E4%BC%98%E5%8A%BF%E5%8F%91%E5%B1%95%E6%99%BA%E6%85%A7%E6%9E%9C%E4%B8%9A%E7%9A%84%E5%AE%9E%E6%96%BD%E6%84%8F%E8%A7%81.pdf)
- [宁县智慧果园监管平台绩效自评报告](https://www.ningxian.gov.cn/Upload/czj/InfoPublicity/PublicInformation/File/2025/09/11/202509111117006002.pdf)
- [庆阳市农技推广中心预算公开说明](https://nync.zgqingyang.gov.cn/Upload/nmj/pdf/2024/02/18/%E5%BA%86%E9%98%B3%E5%B8%82%E5%86%9C%E4%B8%9A%E6%8A%80%E6%9C%AF%E6%8E%A8%E5%B9%BF%E4%B8%AD%E5%BF%832024%E5%B9%B4%E9%83%A8%E9%97%A8%E5%8D%95%E4%BD%8D%E9%A2%84%E7%AE%97%E5%85%AC%E5%BC%80%E6%83%85%E5%86%B5%E8%AF%B4%E6%98%8E.pdf)
- [甘肃庆城苹果试验示范站](https://yyxy.nwafu.edu.cn/kytg/sysfz/127001.htm)
