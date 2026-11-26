import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageConfig } from "../config.js";
import type { Tool } from "./index.js";

type ImagesResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
};

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
  return cleaned || "image";
}

/**
 * Accepts either a base URL (`.../v1`, `.../api/v3`) or the full endpoint, because
 * provider dashboards hand out the complete `/images/generations` URL and pasting
 * it must not produce a doubled path.
 */
function generationEndpoint(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  return /\/images\/generations$/i.test(clean) ? clean : `${clean}/images/generations`;
}

function extFromContentType(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

/**
 * Generates one image through an OpenAI-compatible `images/generations` endpoint
 * and saves it under the data directory. The API key stays server-side; the model
 * only ever sees the saved path.
 */
export function createImageTool(config: ImageConfig): Tool {
  const endpoint = generationEndpoint(config.baseUrl);

  return {
    name: "image_generate",
    description:
      `Create one image from a text prompt with the image model ${config.model} and save it as a file. ` +
      "Use this whenever the user asks for a picture, illustration, poster, avatar or artwork. " +
      "Returns the absolute path of the saved file, which you can hand to a colleague or other tool.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What the picture should show: subject, setting, style, colours, lighting and any text-free composition notes. English works best.",
        },
        size: {
          type: "string",
          description: `Image size such as "1024x1024", "1024x1536" or "1536x1024". Defaults to ${config.size}.`,
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async handler(args) {
      const prompt = requirePrompt(args);
      const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : config.size;

      const body: Record<string, unknown> = { model: config.model, prompt, n: 1, size };
      // Only the DALL·E models take `response_format`; gpt-image-1 always returns b64.
      if (config.model.startsWith("dall-e")) body.response_format = "b64_json";

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await response.text();

      let parsed: ImagesResponse;
      try {
        parsed = JSON.parse(text) as ImagesResponse;
      } catch {
        throw new Error(`Image API returned a non-JSON response (${response.status}): ${text.slice(0, 300)}`);
      }

      if (!response.ok || parsed.error) {
        const detail = parsed.error?.message ?? text.slice(0, 300);
        throw new Error(`Image API rejected the request (${response.status}): ${detail}`);
      }

      const first = parsed.data?.[0];
      if (!first) throw new Error(`Image API returned no image: ${text.slice(0, 200)}`);

      let bytes: Buffer;
      let ext: string;
      if (first.b64_json) {
        bytes = Buffer.from(first.b64_json, "base64");
        ext = "png";
      } else if (first.url) {
        const download = await fetch(first.url, { signal: AbortSignal.timeout(120_000) });
        if (!download.ok) {
          throw new Error(`Image was generated but downloading it failed (${download.status})`);
        }
        bytes = Buffer.from(await download.arrayBuffer());
        ext = extFromContentType(download.headers.get("content-type") ?? "");
      } else {
        throw new Error("Image API returned neither b64_json nor a url.");
      }

      if (bytes.byteLength === 0) throw new Error("Image API returned an empty file.");

      await mkdir(config.outputDir, { recursive: true });
      const file = path.join(config.outputDir, `${fileStamp()}-${slug(prompt)}.${ext}`);
      await writeFile(file, bytes);

      const sizeLabel =
        bytes.byteLength < 1024 ? `${bytes.byteLength} bytes` : `${Math.round(bytes.byteLength / 1024)} KB`;
      return `Generated 1 image with ${config.model} (${size}, ${sizeLabel}) and saved it to ${file}`;
    },
  };
}
