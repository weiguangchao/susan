# read 图片支持移植记录

来源：[Pi 400d6905ce46ec46e79da8a7701b1b48850192df](https://github.com/earendil-works/pi/tree/400d6905ce46ec46e79da8a7701b1b48850192df)，对应「任务：read 图片支持（Pi 对齐）」。许可证见根目录 THIRD_PARTY_NOTICES，随 npm 包分发。

## 移植范围

`packages/coding-agent/src/utils/` 下 mime、image-process、image-convert、image-resize-core、image-resize、image-resize-worker、exif-orientation 移至 `src/core/`，保留魔数检测、BMP 头验证、JPEG-LS/APNG 排除、EXIF 方向处理、格式转换、缩放算法与失败文案。read 的图片分支和 description 按同版本 `core/tools/read.ts` 接入。

JPEG/PNG/GIF/WebP 在符合限制时保持原数据，BMP 先转 PNG；并非所有图片无条件转 PNG。默认边长限制 2000、base64 长度严格小于 4.5 MiB，编码顺序与质量回退采用 Pi 源码（起始 JPEG quality 80）。未能转换/缩放时产出 Pi 的 `[Image omitted: ...]` 文本。

Susan 使用 Node/npm：photon loader 直接懒加载 `@silvia-odwyer/photon-node`，由依赖定位相邻 WASM，未移植 Pi 的 Bun 全局 fs patch 与二进制路径回退。独立 worker 作为 tsdown entry 随包发布；源码运行时 worker 无法加载则按 Pi 回退到进程内处理。

## 模型与消息通道

模型目录新增可选 `input`，例如 `{"id":"vision-model","input":["text","image"]}`。未配置时 Harness 按仅文本处理；不从模型名称猜测能力。配置初次加载和 `/model` 切换均传入当前能力，read 在文本模型下追加 Pi 提示，但图片块仍进入 Tool Result 与 Session Transcript。

OpenAI Chat Completions 请求转换依照 Pi `packages/ai/src/api/openai-completions.ts` 的 tool-result 图片分支：连续 tool 结果先全部发送，再追加一条 user 消息承载有序 image_url data URLs。仅视觉模型发送图片，文本模型省略图片；不修改原消息。仅图片结果采用 `(see attached image)`，空结果采用 `(no tool output)`。

原有 Session v4 已支持 ImageContent 校验，本次不升版。TUI 用图片数量/MIME 与处理提示显示附件，不把 base64 打到终端；当前 Ink 前端使用文本附件展示，不绘制终端位图。上下文估算每张图片暂计 1200 tokens（启发式估算，不是 provider 实际计费），compaction 文本保留图片附件标记，不序列化 base64；整体 compaction 移植仍由其独立任务承担。

## 验证

`test/read-images.test.ts` 覆盖 read、魔数拒绝、真实 Photon 转换/缩放、失败语义、TUI 摘要、Session 往返、请求批次顺序与过滤，以及 Harness 模型切换。旧实现的图片分页用例先因 Offset 越界失败，再通过图片分支。

安装包 smoke 会在独立安装目录启动实际打包 worker，验证依赖 WASM 能解码 PNG。真实视觉服务调用与真实终端人工验收未执行。
