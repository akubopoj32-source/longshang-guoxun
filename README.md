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

## 浏览器调试

需要 Python 3.10 或更新版本。Python 服务无需安装第三方运行依赖。

```powershell
python app.py
```

打开 [本地工作台](http://127.0.0.1:8765)。记录保存在本地 `.orchard/records.sqlite3`，默认只监听本机。左侧可按「全部」「待复核」「已复核」筛选记录，浏览器刷新会恢复最近一次打开的记录。

### 跑通演示

1. 新建「诱捕监测」记录。输入「三号点看到两只疑似虫体」，可附一张有权使用的图片。
2. 回答「今天上午，刚才说错了，是五号点」。核对当前点位、原文证据和修订历史。没有图片时可以补充「没拍照」。
3. 提交复核、确认当前版本，然后导出 JSON。虫体类别仍显示为待核实。

### 配置图文模型

默认使用本地规则演示，可以留存并复核原图。要启用视觉提取和基于图片质量的补拍追问，配置支持图文输入的 Chat Completions 兼容服务，然后重启。

```powershell
$env:ORCHARD_MODEL_URL = 'https://your-model-provider.example/v1/chat/completions'
$env:ORCHARD_MODEL = '服务商提供的视觉模型标识'
$env:ORCHARD_MODEL_KEY = '本机的服务密钥'
python app.py
```

桌面客户端可从同一个 PowerShell 窗口启动，继承这些环境变量。Docker Compose 也会读取这些变量。启用后，本轮文字、图片及用于提取的当前字段将发送到配置的模型服务。仅使用获准传输的材料，密钥通过本机环境变量配置。当前复核视图用于本地原型演示，巡查与复核共用工作台。

巡查员原话与照片可见线索分别保存。诱捕监测中，当同轮有明确口述数量且模型认为照片完整、可计数时，数量不同会列入「图文证据待核对」，并关联原话及原图。局部或模糊图优先进入补拍或待核对流程。模型服务失败时，本轮输入保留在表单中，可重试或选择「用规则保存本轮」。规则模式会保存原图，视觉识别留待后续核对。

## 离线开发评测

在项目根目录运行。评测直接调用工作台使用的巡查规则，可在没有模型密钥时运行。

```powershell
python -m evaluation.run --mode fixture --input multimodal --output 'local/评测结果/模拟图文.json'
python -m evaluation.run --mode fixture --input text --output 'local/评测结果/模拟纯文本.json'
python -m evaluation.run --mode rules --input multimodal --output 'local/评测结果/规则图文.json'
```

`fixture` 模式使用本地文字规则和案例中预先写好的视觉响应，可模拟有限视野、数量差异及异常候选字段。`rules` 模式验证实际的本地规则和照片留存流程。纯文本输入会省略图片。两种模式都在本地运行，结果用于开发验收。真实视觉效果应在接入模型后单独实测。

在 [案例文件](evaluation/cases.json) 中填写任务、输入步骤和预期结果。`expect` 适用于所有运行方式，`expect_by_variant` 可针对 `fixture-multimodal` 等运行方式覆盖预期值。`evaluation/fixtures/` 中的图片是团队自制示意图，用于模拟不同图像条件。输出 JSON 记录每步的字段、追问、修订历史、待核对项和逐项断言，也记录所用案例文件和图片的 SHA-256。断言失败时仍会输出结果，命令以退出码 1 结束。

## 参赛资料

- [项目策划书](docs/陇上果巡项目策划书.md)
- [策划书打印版](docs/陇上果巡项目策划书_打印版.pdf)
- [策划书导师审阅稿](docs/陇上果巡项目策划书_导师审阅稿.pdf)
- [大赛方案](references/2026年中国算谷人工智能大赛方案.pdf)
- [大赛官方参赛规则](https://cvaic.qyvtc.cn/rules)

## 目录说明

| 路径 | 内容 |
|---|---|
| `app.py` | 本地工作台启动入口 |
| `desktop/` | Electron 桌面入口和 Windows 打包脚本 |
| `Dockerfile`、`compose.yaml` | 服务镜像与本地容器部署 |
| `orchard_workbench/` | 服务端、巡查规则与网页 |
| `evaluation/` | 离线评测入口、开发案例和自制示意图 |
| `docs/` | 项目策划书及可打印版本 |
| `references/` | 赛事方案及庆阳果业公开资料 |
| `local/` | 本机报名材料、快捷方式和测试产物，Git 忽略 |
| `.orchard/` | 本机运行数据，Git 忽略 |

## 庆阳果业参考资料

[已归档的资料文件](references/庆阳果业参考资料)和原始来源如下。

- [庆阳市智慧果业实施意见](https://zgqingyang.gov.cn/Upload/main/pdf/2025/03/20/%E5%BA%86%E9%98%B3%E5%B8%82%E4%BA%BA%E6%B0%91%E6%94%BF%E5%BA%9C%E5%8A%9E%E5%85%AC%E5%AE%A4%E5%85%B3%E4%BA%8E%E4%BE%9D%E6%89%98%E6%95%B0%E5%AD%97%E4%BA%A7%E4%B8%9A%E4%BC%98%E5%8A%BF%E5%8F%91%E5%B1%95%E6%99%BA%E6%85%A7%E6%9E%9C%E4%B8%9A%E7%9A%84%E5%AE%9E%E6%96%BD%E6%84%8F%E8%A7%81.pdf)
- [宁县智慧果园监管平台绩效自评报告](https://www.ningxian.gov.cn/Upload/czj/InfoPublicity/PublicInformation/File/2025/09/11/202509111117006002.pdf)
- [庆阳市农技推广中心预算公开说明](https://nync.zgqingyang.gov.cn/Upload/nmj/pdf/2024/02/18/%E5%BA%86%E9%98%B3%E5%B8%82%E5%86%9C%E4%B8%9A%E6%8A%80%E6%9C%AF%E6%8E%A8%E5%B9%BF%E4%B8%AD%E5%BF%832024%E5%B9%B4%E9%83%A8%E9%97%A8%E5%8D%95%E4%BD%8D%E9%A2%84%E7%AE%97%E5%85%AC%E5%BC%80%E6%83%85%E5%86%B5%E8%AF%B4%E6%98%8E.pdf)
- [甘肃庆城苹果试验示范站](https://yyxy.nwafu.edu.cn/kytg/sysfz/127001.htm)
