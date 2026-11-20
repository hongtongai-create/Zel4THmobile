import type { FacebookConfig } from "../config.js";
import type { Tool } from "./index.js";

type GraphError = { error?: { message?: string; type?: string; code?: number } };

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${key}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Posts to the configured Facebook Page feed via the Graph API.
 * The page access token stays server-side; the model never sees it.
 */
export function createFacebookTool(config: FacebookConfig): Tool {
  const base = `${config.graphBaseUrl.replace(/\/+$/, "")}/${config.graphVersion}`;
  const pageLabel = config.pageName ? `${config.pageName} (${config.pageId})` : config.pageId;

  return {
    name: "facebook_post",
    description:
      `Publish a post to the Facebook Page ${pageLabel}. Use this when the user asks you to post, publish or share something on Facebook. ` +
      "Returns the new post id and its public URL.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The post text. Supports line breaks and emoji.",
        },
        link: {
          type: "string",
          description: "Optional URL to attach to the post as a link preview.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    async handler(args) {
      const message = requireString(args, "message");
      const link = typeof args.link === "string" && args.link.trim() ? args.link.trim() : null;

      const form = new URLSearchParams();
      form.set("message", message);
      if (link) form.set("link", link);
      form.set("access_token", config.pageAccessToken);

      const response = await fetch(`${base}/${config.pageId}/feed`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();

      let parsed: { id?: string } & GraphError;
      try {
        parsed = JSON.parse(text) as { id?: string } & GraphError;
      } catch {
        throw new Error(`Graph API returned a non-JSON response (${response.status}): ${text.slice(0, 300)}`);
      }

      if (!response.ok || parsed.error) {
        const detail = parsed.error?.message ?? text.slice(0, 300);
        throw new Error(`Facebook rejected the post (${response.status}): ${detail}`);
      }
      if (!parsed.id) {
        throw new Error(`Facebook accepted the request but returned no post id: ${text.slice(0, 200)}`);
      }

      const url = `https://www.facebook.com/${parsed.id}`;
      return `Posted to Facebook Page ${pageLabel}. Post id: ${parsed.id}. URL: ${url}`;
    },
  };
}
