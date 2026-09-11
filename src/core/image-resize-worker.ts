// Ported from Pi 400d690 (MIT); see docs/research/2026-09-10-read-images-port.md.
import { parentPort } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.js";

interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { result };
			port.postMessage(response);
		} catch (error) {
			const response: ResizeImageWorkerResponse = {
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
