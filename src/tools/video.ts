import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoConfig } from "../config.js";
import type { Tool } from "./index.js";

type CreateTaskResponse = {
  id?: string;
  error?: { code?: string; message?: string };
};

type TaskStatus = {
  id?: string;
  status?: string;
  content?: { video_url?: string };
  duration?: number;
  error?: { code?: string; message?: string };
};

const POLL_INTERVAL_MS = 5_000;

function requirePrompt(args: Record<string, unknown>): string {
  const value = args.prompt;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error('"prompt" is required and must be a non-empty string.');
  }
  return value.trim();
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function slug(prompt: string): string {
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "video";
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  return "mp4";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Generates one video through the ModelArk-style asynchronous task API:
 * POST <tasks> creates a job, GET <tasks>/<id> is polled until it succeeds,
 * then the signed video URL is downloaded into the data directory.
 */
export function createVideoTool(config: VideoConfig): Tool {
  const tasksUrl = config.tasksUrl.replace(/\/+$/, "");

  return {
    name: "video_generate",
    description:
      `Create one short video from a text prompt with the video model ${config.model} and save it as a file. ` +
      `Use this when the user asks for a video, clip, animation or motion shot. Rendering takes a minute or two. ` +
      "Returns the absolute path of the saved file together with its duration and size.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What the video should show, as a shot description: subject, action, camera movement, setting, lighting and mood. English works best.",
        },
        duration: {
          type: "integer",
          description: `Length in seconds. Defaults to ${config.duration}.`,
        },
        ratio: {
          type: "string",
          description: `Aspect ratio such as "16:9", "9:16" or "1:1". Defaults to ${config.ratio}.`,
        },
        resolution: {
          type: "string",
          description: `Output resolution: "480p", "720p" or "1080p". Defaults to ${config.resolution}.`,
        },
        watermark: {
          type: "boolean",
          description: "Add the provider watermark. Defaults to false.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async handler(args) {
      const prompt = requirePrompt(args);
      const duration =
        typeof args.duration === "number" && Number.isFinite(args.duration)
          ? Math.trunc(args.duration)
          : config.duration;
      const ratio = typeof args.ratio === "string" && args.ratio.trim() ? args.ratio.trim() : config.ratio;
      const resolution =
        typeof args.resolution === "string" && args.resolution.trim()
          ? args.resolution.trim()
          : config.resolution;
      const watermark = args.watermark === true;

      const createResponse = await fetch(tasksUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          content: [{ type: "text", text: prompt }],
          duration,
          ratio,
          resolution,
          watermark,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const createText = await createResponse.text();
      let created: CreateTaskResponse;
      try {
        created = JSON.parse(createText) as CreateTaskResponse;
      } catch {
        throw new Error(`Video API returned a non-JSON response (${createResponse.status}): ${createText.slice(0, 300)}`);
      }
      if (!createResponse.ok || created.error) {
        const detail = created.error?.message ?? createText.slice(0, 300);
        throw new Error(`Video API rejected the task (${createResponse.status}): ${detail}`);
      }
      const taskId = created.id;
      if (!taskId) throw new Error(`Video API accepted the task but returned no id: ${createText.slice(0, 200)}`);

      const deadline = Date.now() + config.timeoutMs;
      let task: TaskStatus | null = null;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const pollResponse = await fetch(`${tasksUrl}/${encodeURIComponent(taskId)}`, {
          headers: { authorization: `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(60_000),
        });
        const pollText = await pollResponse.text();
        try {
          task = JSON.parse(pollText) as TaskStatus;
        } catch {
          throw new Error(`Video API returned a non-JSON status (${pollResponse.status}): ${pollText.slice(0, 200)}`);
        }
        if (!pollResponse.ok) {
          throw new Error(`Video status check failed (${pollResponse.status}): ${pollText.slice(0, 200)}`);
        }
        const status = task.status ?? "";
        if (status === "succeeded") break;
        if (status === "failed" || status === "cancelled" || status === "expired") {
          const detail = task.error?.message ?? task.error?.code ?? status;
          throw new Error(`Video task ${taskId} ${status}: ${detail}`);
        }
      }

      if (task?.status !== "succeeded" || !task.content?.video_url) {
        throw new Error(
          `Video task ${taskId} did not finish within ${Math.round(config.timeoutMs / 1000)}s (last status: ${
            task?.status ?? "unknown"
          }). The task keeps running on the provider; ask again later to fetch it.`,
        );
      }

      const download = await fetch(task.content.video_url, { signal: AbortSignal.timeout(180_000) });
      if (!download.ok) {
        throw new Error(`Video was generated but downloading it failed (${download.status})`);
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("Video API returned an empty file.");

      const ext = extFromContentType(download.headers.get("content-type") ?? "");
      await mkdir(config.outputDir, { recursive: true });
      const file = path.join(config.outputDir, `${fileStamp()}-${slug(prompt)}.${ext}`);
      await writeFile(file, bytes);

      const seconds = task.duration ?? duration;
      const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      return (
        `Generated a ${seconds}s ${resolution} ${ratio} video with ${config.model} (${mb} MB) and saved it to ${file}` +
        ` (task ${taskId})`
      );
    },
  };
}
