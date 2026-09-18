# read 图片支持移植记录

来源：[Pi 400d6905ce46ec46e79da8a7701b1b48850192df](https://github.com/earendil-works/pi/tree/400d6905ce46ec46e79da8a7701b1b48850192df)，对应「任务：read 图片支持（Pi 对齐）」。许可证见根目录 THIRD_PARTY_NOTICES，随 npm 包分发。

## 移植范围

当前行为以 [#123](https://github.com/weiguangchao/susan/issues/123) 和 [#116](https://github.com/weiguangchao/susan/issues/116) 的原样转发契约为准。保留 Pi 的 MIME 魔数检测、BMP 头验证、JPEG-LS/APNG 排除，不扩大格式识别范围。

Read Tool 将原文件字节直接编码为 base64 Image Content，保留 MIME。BMP 不转换格式，超过旧尺寸或体积阈值的图片也原样发送。不执行缩放、压缩、EXIF 修正或解码重编码。历史图片加工模块与依赖已删除；上游拒绝由现有 Provider Failure 处理。

## 模型与消息通道

模型目录新增可选 `input`，例如 `{"id":"vision-model","input":["text","image"]}`。未配置时 Harness 按仅文本处理；不从模型名称猜测能力。配置初次加载和 `/model` 切换均传入当前能力，read 在文本模型下追加 Pi 提示，但图片块仍进入 Tool Result 与 Session Transcript。

OpenAI Chat Completions 请求转换依照 Pi `packages/ai/src/api/openai-completions.ts` 的 tool-result 图片分支：连续 tool 结果先全部发送，再追加一条 user 消息承载有序 image_url data URLs。仅视觉模型发送图片，文本模型省略图片；不修改原消息。仅图片结果采用 `(see attached image)`，空结果采用 `(no tool output)`。

原有 Session v4 已支持 ImageContent 校验，本次不升版。TUI 用图片数量/MIME 显示附件，不把 base64 打到终端；当前 Ink 前端使用文本附件展示，不绘制终端位图。上下文估算每张图片暂计 1200 tokens（启发式估算，不是 provider 实际计费），compaction 文本保留图片附件标记，不序列化 base64；整体 compaction 移植仍由其独立任务承担。

## 验证

`test/read-images.test.ts` 通过 Read Tool、Session Store、Provider Adapter 和 Harness 验证原始字节及 MIME、超过旧阈值的 BMP、Session 往返、请求批次顺序、非视觉过滤与切回恢复，以及上游拒绝的 Provider Failure。保留 MIME 拒绝、TUI 摘要和 Harness 模型切换测试。

安装包 smoke 检查当前单包产物与 CLI。历史图片加工的构建入口及产物 smoke 已删除；拆包后的 Harness 原始 tarball 无残留验收由后续包迁移工单承接。真实视觉服务调用与真实终端人工验收未执行。
