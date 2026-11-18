# ZhishengTag · 枳生Ai桌签

Windows 桌面工作台。分段录音、语音与文字便签、来源可追溯的待办和每日计划。

## 运行

带有 runtime 目录的 Windows x64 便携开发包可以双击 **Launch-ZhishengTag.cmd** 启动。**启动开发版.cmd** 默认使用本项目的 .dev-data，方便隔离试用。

从 GitHub 获取的源码请先运行 npm ci，安装锁定版本的 Electron，再运行 npm start。完成首次安装后也可以使用上述两个启动脚本。

## 构建 Windows x64 发行包

在 Windows 上打开项目目录，运行：

```powershell
npm ci
npm run dist:win
```

首次构建会下载打包工具。完成后，`dist/windows` 下的 `*-setup.exe` 是当前用户的一键安装程序，`*-portable.zip` 包含可直接运行的完整目录。若本地已有与锁定版本一致的 Windows x64 Electron 解压目录，可在构建命令末尾加上 `-- --config.electronDist=该目录的绝对路径`。

## 源码与数据

| 文件 | 职责 |
| --- | --- |
| main.js / preload.js | 桌面窗口、托盘、权限、旧便签存储、IPC |
| capture.js | 有界分段录音、输入电平、麦克风释放、必要时转换为 16 kHz WAV |
| desk.js | 本地录音档案、串行处理队列、转录策略、任务与计划、加密配置 |
| ai.js | 厂商预设、模型目录、请求适配、SSE 解析 |
| manager.html / manager.js / manager.css | 工作台、时间轴、便签簿、计划、接入设置 |
| note.html / note.js / note.css | 桌面便签、文字编辑、听写和 AI 预览 |
| theme.css / assets | 界面色彩和材质、交互、品牌标记 |

默认数据目录为 %APPDATA%\ZhishengTag。可用 ZHISHENG_TAG_DATA 指定目录，原 PAPER_NOTES_DATA 仍可作为路径覆盖。首次启动且新目录中没有便签时，会读取旧版 E:\PaperNotes\data 或旧用户目录的便签 JSON，将内容迁入新目录。

录音本体以独立 Opus 片段保存在 recordings，每段有单独的转写与整理元数据。任务与计划写入 desk.json。AI Key 通过 Electron safeStorage 调用 Windows 的加密能力，存入 ai-settings.json。录音回放和失败重试使用本地片段。备份便签时导出便签 JSON，整机迁移请备份数据目录，换电脑后重新输入 API Key。

## 测试

运行 npm test，或用随包的 Electron 执行 . --smoke-test。测试用模拟麦克风和本地 API 响应，验证真实 Electron 窗口、流式输出、本地数据持久化和重启恢复。数据默认写入 .smoke-data，可用 ZHISHENG_SMOKE_DATA 和 PAPER_TEST_REPORT 指定独立数据及报告目录。

现有验证覆盖分段、窗口收起后的录音控制、暂停、恢复、失败重试、模型目录、OpenAI 和 Claude 流式文字、OpenAI 转录及百炼 WAV 请求。实际服务权限、长时硬件续航和录音质量随账号、麦克风和电源策略变化。

## API 文档

预设依照 2026 年 11 月 18 日的厂商参考。运行时可拉取账号可见的模型，也能填写已开通的模型 ID。豆包支持填写推理接入点 ID。百炼按工作空间和地域查询。

| 预设 | 官方参考 |
| --- | --- |
| OpenAI | [Responses 流式输出](https://developers.openai.com/api/docs/guides/streaming-responses) / [转录](https://developers.openai.com/api/docs/guides/speech-to-text) |
| Anthropic Claude | [模型目录](https://platform.claude.com/docs/en/models/overview) / [API 版本](https://platform.claude.com/docs/en/api/versioning?version=2026-10-21) |
| DeepSeek | [查询模型](https://api-docs.deepseek.com/api/list-models/) / [更新记录](https://api-docs.deepseek.com/updates/) |
| 通义千问 · 百炼 | [模型目录](https://docs.modelstudio.console.alibabacloud.com/zh/model-studio/list-models) / [Qwen-ASR](https://www.alibabacloud.com/help/zh/model-studio/qwen-asr-api-reference) |
| 豆包 · 火山方舟 | [模型查询](https://docs.volcengine.com/docs/ark/models-api?lang=en) / [推理接口](https://docs.volcengine.com/docs/ark/agent-model-invocation-practice?lang=en) |
| Kimi | [模型列表](https://platform.kimi.com/docs/api/list-models) / [模型参数](https://platform.kimi.com/docs/api/models-overview) |
| 混元与 GLM · 腾讯云 | [OpenAI 兼容接口与模型列表](https://cloud.tencent.com/document/product/1823/130078) |
| 文心 · 百度千帆 | [查询模型](https://cloud.baidu.com/doc/qianfan-api/s/Amwbl43sp) / [兼容推理接口](https://cloud.baidu.com/doc/qianfan-docs/s/Fm9l6ocai) |
| 硅基流动 | [快速上手](https://docs.siliconflow.cn/docs/userguide/quickstart) / [语音转录](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post) |
| Google Gemini | [OpenAI 兼容接口与模型列表](https://aistudio.google.com/docs/openai) |
| Groq | [语音转录](https://console.groq.com/docs/speech-to-text) |

应用保留原开发包的 MIT 署名。运行时第三方声明见 runtime\LICENSE 与 runtime\LICENSES.chromium.html。
