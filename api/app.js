import { createHmac, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const VERSION = "2.0.0";
const present = (name) => Boolean(String(process.env[name] || "").trim());
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const env = (requireRefresh = true) => {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_KEY", "MCP_BEARER_TOKEN"];
  const missing = required.filter((name) => !present(name));
  if (missing.length) throw new Error(`Environment belum lengkap: ${missing.join(", ")}`);
  if (requireRefresh && !present("GOOGLE_REFRESH_TOKEN")) throw new Error("GOOGLE_REFRESH_TOKEN belum diisi. Buka /connect.");
  return {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN,
    ADMIN_KEY: process.env.ADMIN_KEY,
    MCP_BEARER_TOKEN: process.env.MCP_BEARER_TOKEN
  };
};
const assertAdmin = (req) => {
  if (!safeEqual(req.headers["x-admin-key"], env(false).ADMIN_KEY)) throw new Error("ADMIN_KEY salah.");
};
const assertMcp = (req) => {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(bearer, env(false).MCP_BEARER_TOKEN)) throw new Error("Token MCP salah.");
};
const oauthClient = (redirectUri, requireRefresh = true) => {
  const e = env(requireRefresh);
  const client = new google.auth.OAuth2(e.GOOGLE_CLIENT_ID, e.GOOGLE_CLIENT_SECRET, redirectUri);
  if (e.GOOGLE_REFRESH_TOKEN) client.setCredentials({ refresh_token: e.GOOGLE_REFRESH_TOKEN });
  return client;
};
const accessToken = async () => {
  const result = await oauthClient().getAccessToken();
  if (!result.token) throw new Error("Google tidak mengembalikan access token.");
  return result.token;
};
const yt = () => google.youtube({ version: "v3", auth: oauthClient() });
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const stateCreate = () => {
  const ts = Date.now().toString();
  const sig = createHmac("sha256", env(false).ADMIN_KEY).update(ts).digest("hex");
  return Buffer.from(`${ts}.${sig}`).toString("base64url");
};
const stateValid = (value) => {
  try {
    const [ts, sig] = Buffer.from(String(value), "base64url").toString("utf8").split(".");
    if (!ts || !sig || Date.now() - Number(ts) > 600000) return false;
    const expected = createHmac("sha256", env(false).ADMIN_KEY).update(ts).digest("hex");
    return safeEqual(sig, expected);
  } catch { return false; }
};
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));

function makeMcpServer() {
  const server = new McpServer({ name: "youtube-android-cloud", version: VERSION });
  server.registerTool("youtube_channel_summary", { description: "Baca identitas dan statistik channel.", inputSchema: {} }, async () => {
    const { data } = await yt().channels.list({ part: ["snippet", "statistics", "contentDetails"], mine: true });
    return text(data.items?.[0] ?? null);
  });
  server.registerTool("youtube_list_recent_videos", { description: "Daftar video terbaru.", inputSchema: { maxResults: z.number().int().min(1).max(50).default(10) } }, async ({ maxResults }) => {
    const api = yt();
    const channel = await api.channels.list({ part: ["contentDetails"], mine: true });
    const playlistId = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) throw new Error("Playlist upload tidak ditemukan.");
    const { data } = await api.playlistItems.list({ part: ["snippet", "contentDetails"], playlistId, maxResults });
    return text(data.items ?? []);
  });
  server.registerTool("youtube_get_video", { description: "Detail metadata dan statistik video.", inputSchema: { videoId: z.string().min(1) } }, async ({ videoId }) => {
    const { data } = await yt().videos.list({ part: ["snippet", "status", "statistics", "contentDetails"], id: [videoId] });
    return text(data.items?.[0] ?? null);
  });
  server.registerTool("youtube_list_comments", { description: "Baca komentar terbaru video.", inputSchema: { videoId: z.string().min(1), maxResults: z.number().int().min(1).max(100).default(20) } }, async ({ videoId, maxResults }) => {
    const { data } = await yt().commentThreads.list({ part: ["snippet", "replies"], videoId, maxResults, order: "time" });
    return text(data.items ?? []);
  });
  server.registerTool("youtube_list_playlists", { description: "Daftar playlist channel.", inputSchema: { maxResults: z.number().int().min(1).max(50).default(25) } }, async ({ maxResults }) => {
    const { data } = await yt().playlists.list({ part: ["snippet", "status", "contentDetails"], mine: true, maxResults });
    return text(data.items ?? []);
  });
  server.registerTool("youtube_reply_to_comment", { description: "Balas komentar; wajib confirm=true.", inputSchema: { parentId: z.string().min(1), text: z.string().min(1).max(10000), confirm: z.literal(true) } }, async ({ parentId, text: reply }) => {
    const { data } = await yt().comments.insert({ part: ["snippet"], requestBody: { snippet: { parentId, textOriginal: reply } } });
    return text(data);
  });
  server.registerTool("youtube_create_playlist", { description: "Buat playlist; wajib confirm=true.", inputSchema: { title: z.string().min(1).max(150), description: z.string().max(5000).default(""), privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"), confirm: z.literal(true) } }, async ({ title, description, privacyStatus }) => {
    const { data } = await yt().playlists.insert({ part: ["snippet", "status"], requestBody: { snippet: { title, description }, status: { privacyStatus } } });
    return text(data);
  });
  server.registerTool("youtube_add_video_to_playlist", { description: "Masukkan video ke playlist; wajib confirm=true.", inputSchema: { playlistId: z.string().min(1), videoId: z.string().min(1), confirm: z.literal(true) } }, async ({ playlistId, videoId }) => {
    const { data } = await yt().playlistItems.insert({ part: ["snippet"], requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } } });
    return text(data);
  });
  server.registerTool("youtube_update_video_metadata", { description: "Ubah metadata video; wajib confirm=true.", inputSchema: { videoId: z.string().min(1), title: z.string().min(1).max(100), description: z.string().max(5000).default(""), tags: z.array(z.string()).max(30).default([]), categoryId: z.string().regex(/^\d+$/).default("22"), privacyStatus: z.enum(["private", "unlisted", "public"]).optional(), publishAt: z.string().datetime({ offset: true }).optional(), confirm: z.literal(true) } }, async ({ videoId, title, description, tags, categoryId, privacyStatus, publishAt }) => {
    const api = yt();
    const found = await api.videos.list({ part: ["snippet", "status"], id: [videoId] });
    const current = found.data.items?.[0];
    if (!current) throw new Error("Video tidak ditemukan.");
    const status = { ...(current.status ?? {}) };
    if (privacyStatus) status.privacyStatus = publishAt ? "private" : privacyStatus;
    if (publishAt) status.publishAt = publishAt;
    const { data } = await api.videos.update({ part: ["snippet", "status"], requestBody: { id: videoId, snippet: { ...(current.snippet ?? {}), title, description, tags, categoryId }, status } });
    return text(data);
  });
  return server;
}

const uploadSchema = z.object({
  title: z.string().min(1).max(100), description: z.string().max(5000).default(""),
  tags: z.array(z.string().min(1).max(60)).max(30).default([]), categoryId: z.string().regex(/^\d+$/).default("22"),
  privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"), publishAt: z.string().datetime({ offset: true }).optional(),
  madeForKids: z.boolean().default(false), fileSize: z.number().int().positive(), mimeType: z.string().regex(/^video\//),
  notifySubscribers: z.boolean().default(false)
});

export default async function handler(req, res) {
  const action = String(req.query.action || "");
  try {
    if (action === "config") {
      const googleClientConfigured = present("GOOGLE_CLIENT_ID") && present("GOOGLE_CLIENT_SECRET");
      const googleChannelConnected = present("GOOGLE_REFRESH_TOKEN");
      const adminKeyConfigured = present("ADMIN_KEY");
      const mcpTokenConfigured = present("MCP_BEARER_TOKEN");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, service: "youtube-mcp-android-cloud", version: VERSION, setup: { googleClientConfigured, googleChannelConnected, adminKeyConfigured, mcpTokenConfigured, readyForDashboard: googleClientConfigured && googleChannelConnected && adminKeyConfigured, readyForMcp: googleClientConfigured && googleChannelConnected && mcpTokenConfigured } });
    }
    if (action === "oauth-start") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      assertAdmin(req);
      const redirectUri = `https://${req.headers.host}/api/oauth-callback`;
      const url = oauthClient(redirectUri, false).generateAuthUrl({ access_type: "offline", prompt: "consent", include_granted_scopes: true, state: stateCreate(), scope: ["https://www.googleapis.com/auth/youtube.force-ssl", "https://www.googleapis.com/auth/youtube.upload"] });
      return res.status(200).json({ url, redirectUri });
    }
    if (action === "oauth-callback") {
      if (!stateValid(req.query.state) || !req.query.code) throw new Error("Callback OAuth tidak valid atau kedaluwarsa.");
      const redirectUri = `https://${req.headers.host}/api/oauth-callback`;
      const { tokens } = await oauthClient(redirectUri, false).getToken(String(req.query.code));
      if (!tokens.refresh_token) throw new Error("Refresh token tidak diberikan. Cabut akses aplikasi Google lalu ulangi.");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(`<!doctype html><html lang="id"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#090a0e;color:#fff;padding:24px;max-width:720px;margin:auto}code{display:block;word-break:break-all;background:#171922;padding:16px;border:1px solid #343845;border-radius:14px}b{color:#5eead4}</style><h1>Channel berhasil dihubungkan</h1><p>Salin token berikut ke environment variable <b>GOOGLE_REFRESH_TOKEN</b> di Vercel. Jangan kirim token ini kepada siapa pun.</p><code>${esc(tokens.refresh_token)}</code></html>`);
    }
    if (action === "upload-session") {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      assertAdmin(req);
      const body = uploadSchema.parse(req.body);
      const token = await accessToken();
      const endpoint = new URL("https://www.googleapis.com/upload/youtube/v3/videos");
      endpoint.searchParams.set("uploadType", "resumable"); endpoint.searchParams.set("part", "snippet,status"); endpoint.searchParams.set("notifySubscribers", String(body.notifySubscribers));
      const status = { privacyStatus: body.publishAt ? "private" : body.privacyStatus, selfDeclaredMadeForKids: body.madeForKids };
      if (body.publishAt) status.publishAt = body.publishAt;
      const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(body.fileSize), "X-Upload-Content-Type": body.mimeType }, body: JSON.stringify({ snippet: { title: body.title, description: body.description, tags: body.tags, categoryId: body.categoryId }, status }) });
      const uploadUrl = response.headers.get("location");
      if (!response.ok || !uploadUrl) throw new Error(`Gagal membuat sesi (${response.status}): ${await response.text()}`);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ uploadUrl, accessToken: token, chunkSize: 8 * 1024 * 1024 });
    }
    if (action === "mcp") {
      assertMcp(req);
      if (req.method !== "POST") return res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      const server = makeMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => { transport.close(); server.close(); });
      return;
    }
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (action === "mcp") return res.status(message.includes("Token MCP") ? 401 : 500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null });
    return res.status(message.includes("ADMIN_KEY") ? 401 : 400).json({ error: message });
  }
}
