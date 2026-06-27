/**
 * Gemini web client — talks to gemini.google.com using your signed-in cookies.
 *
 * Reverse-engineered internal StreamGenerate API:
 *  1. GET /app → scrape session tokens (SNlM0e, cfb2h, FdrFJe)
 *  2. POST StreamGenerate with a sparse f.req payload + model-selector header
 *  3. Parse Google's length-prefixed streaming frames (rt=c)
 *
 * No API key. Cookies do the auth.
 */
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://push.clients6.google.com/upload/";
const GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const UPLOAD_MIME = {
  ".bmp": "image/bmp", ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
};

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
const DEFAULT_METADATA = ["", "", "", null, null, null, null, null, null, ""];

// --- Model registry ---------------------------------------------------------

export const MODELS = {
  "gemini-3.1-pro": { hash: "9d8ca3786ebdfbea", capacity: 1 },
  "gemini-3.5-flash": { hash: "fbb127bbb056c959", capacity: 1 },
  "gemini-3.1-flash-lite": { hash: "fbb127bbb056c959", capacity: 1 },
  "gemini-3-pro-deep-think": { hash: "9d8ca3786ebdfbea", capacity: 1 },
};
export const DEFAULT_MODEL = "gemini-3.1-pro";
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

export function resolveModel(desired) {
  const d = typeof desired === "string" ? desired.trim().toLowerCase().replace(/[_\s]+/g, "-") : "";
  switch (d) {
    case "gemini-3.1-pro": case "gemini-3-pro": case "gemini-3.0-pro": case "gemini-2.5-pro": return "gemini-3.1-pro";
    case "gemini-3.5-flash": return "gemini-3.5-flash";
    case "gemini-3.1-flash-lite": case "gemini-3.1-flashlite": case "gemini-2.5-flash": return "gemini-3.1-flash-lite";
    case "gemini-3-deep-think": case "gemini-3-pro-deep-think": case "gemini-3-pro-deepthink": return "gemini-3-pro-deep-think";
    default: return DEFAULT_MODEL;
  }
}

/**
 * Build model-selection headers.
 * Text: 12-element header. Image gen: 17-element header (captured from live web UI).
 */
export function buildModelHeaders(model, options = {}) {
  const spec = MODELS[model] ?? MODELS[DEFAULT_MODEL];
  if (options.imageGeneration) {
    const uuid = options.requestUuid ?? randomUUID().toUpperCase();
    return {
      [MODEL_HEADER_NAME]: JSON.stringify([1, null, null, null, spec.hash, null, null, 0, [4, 5, 6, 8], null, null, spec.capacity, null, null, 1, null, uuid]),
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-73010990-jspb": "[0,0,0]",
    };
  }
  return {
    [MODEL_HEADER_NAME]: JSON.stringify([1, null, null, null, spec.hash, null, null, 0, [4], null, null, spec.capacity]),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0]",
  };
}

// --- Helpers ----------------------------------------------------------------

function buildCookieHeader(map) {
  return Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Build the X-Client-Pctx protobuf blob the upload endpoint expects (field 1 = 5 random bytes). */
function buildClientPctx() {
  const rand = randomBytes(5);
  // 0a 07 12 05 <5 bytes>  — protobuf: field1(len7){ field2(len5){ rand } }
  const buf = Buffer.concat([Buffer.from([0x0a, 0x07, 0x12, 0x05]), rand]);
  return buf.toString("base64");
}

function getNested(value, pathParts, fallback) {
  let cur = value;
  for (const part of pathParts) {
    if (cur == null) return fallback;
    cur = typeof part === "number" ? (Array.isArray(cur) ? cur[part] : undefined) : cur[part];
  }
  return cur ?? fallback;
}

function matchAppToken(html, key) {
  const m = html.match(new RegExp(`"${key}":\\s*"(.*?)"`));
  return m?.[1] ?? null;
}

// --- Session bootstrap ------------------------------------------------------

/** GET /app and scrape the per-session tokens embedded in the HTML. */
export async function fetchSessionBootstrap(cookieMap, signal) {
  const res = await fetch(GEMINI_APP_URL, {
    redirect: "follow", signal,
    headers: { cookie: buildCookieHeader(cookieMap), "user-agent": USER_AGENT },
  });
  const html = await res.text();
  const at = matchAppToken(html, "SNlM0e") ?? matchAppToken(html, "thykhd");
  if (!at) throw new Error("Unable to locate Gemini access token (missing SNlM0e). Cookies may be invalid or expired.");
  return { at, buildLabel: matchAppToken(html, "cfb2h"), sessionId: matchAppToken(html, "FdrFJe") };
}

const BATCHEXEC_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";

/** Warmup RPC the web UI sends before upload/generate (rpcid ESY5D = BARD_SETTINGS). */
export async function sendBardActivity(cookieMap, bootstrap, signal) {
  const params = new URLSearchParams();
  params.set("at", bootstrap.at);
  params.set("f.req", JSON.stringify([[["ESY5D", JSON.stringify([[[["bard_activity_enabled"]]]]), null, "generic"]]]));
  if (bootstrap.buildLabel) params.set("bl", bootstrap.buildLabel);
  if (bootstrap.sessionId) params.set("f.sid", bootstrap.sessionId);
  const res = await fetch(`${BATCHEXEC_URL}?rpcids=ESY5D&source-path=%2Fapp&hl=en&_reqid=${Math.floor(Math.random() * 9e6) + 1e6}&rt=c`, {
    method: "POST", redirect: "follow", signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      origin: "https://gemini.google.com", referer: "https://gemini.google.com/",
      "x-same-domain": "1", "user-agent": USER_AGENT, cookie: buildCookieHeader(cookieMap),
      "x-goog-ext-525001261-jspb": "[1,null,null,null,null,null,null,null,[4]]",
      "x-goog-ext-73010989-jspb": "[0]",
    },
    body: params.toString(),
  });
  await res.text().catch(() => {});
}

// --- File upload (2-step resumable to push.clients6.google.com) -------------

/**
 * Upload a file via Google's resumable upload protocol (matches the live web UI):
 *   1. POST start → returns upload_id in the `x-guploader-uploadid` header.
 *   2. POST raw bytes with `upload, finalize` → returns the contrib_service URL.
 */
async function uploadFile(filePath, signal) {
  const abs = path.resolve(process.cwd(), filePath);
  const data = await readFile(abs);
  const name = path.basename(abs);
  const mimeType = UPLOAD_MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
  const baseHeaders = {
    "push-id": GEMINI_UPLOAD_PUSH_ID,
    "x-tenant-id": "bard-storage",
    "x-client-pctx": buildClientPctx(),
    "user-agent": USER_AGENT,
    referer: "https://gemini.google.com/",
    origin: "https://gemini.google.com",
  };

  // Step 1: start a resumable upload session.
  const startRes = await fetch(GEMINI_UPLOAD_URL, {
    method: "POST", redirect: "follow", signal,
    headers: {
      ...baseHeaders,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(data.byteLength),
      "x-goog-upload-header-content-type": mimeType,
    },
    body: `File name: ${name}`,
  });
  if (!startRes.ok) throw new Error(`Upload start failed: ${startRes.status} ${startRes.statusText}`);
  const uploadId = startRes.headers.get("x-guploader-uploadid");
  if (!uploadId) throw new Error("Upload start did not return an upload id.");

  // Step 2: upload the raw bytes and finalize.
  const uploadUrl = `${GEMINI_UPLOAD_URL}?upload_id=${encodeURIComponent(uploadId)}&upload_protocol=resumable`;
  const finalizeRes = await fetch(uploadUrl, {
    method: "POST", redirect: "follow", signal,
    headers: {
      ...baseHeaders,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    body: data,
  });
  const id = (await finalizeRes.text()).trim();
  if (!finalizeRes.ok || !id) {
    throw new Error(`Upload finalize failed: ${finalizeRes.status} ${finalizeRes.statusText}`);
  }
  return { id, name, mimeType };
}

// --- Request payload --------------------------------------------------------

function buildFReqPayload(prompt, uploaded, chatMetadata, language, imageGeneration) {
  // File-reference format (from live web UI): each file is a 12-element array
  //   [[url, 1, null, mimeType], filename, null, null, null, null, null, null, [0]]
  const fileEntry = (f) => [[f.id, 1, null, f.mimeType], f.name, null, null, null, null, null, null, [0]];
  const reqFileData = uploaded.length > 0 ? uploaded.map(fileEntry) : null;
  const messageContent = [prompt, 0, null, reqFileData, null, null, 0];

  // Attachments AND image generation use the 92-element envelope with the
  // !-nonce at index 3 + hex uuid at index 4 (captured from the live web UI).
  const needsImageEnvelope = imageGeneration || uploaded.length > 0;
  const size = needsImageEnvelope ? 92 : 69;
  const inner = new Array(size).fill(null);
  inner[0] = messageContent;
  inner[1] = [language];
  inner[2] = chatMetadata ?? DEFAULT_METADATA;
  inner[6] = [1];
  inner[7] = 1; // streaming flag (rt=c)
  inner[10] = 1; inner[11] = 0;
  inner[17] = [[0]]; inner[18] = 0;
  inner[27] = 1; inner[30] = [4]; inner[53] = 0;
  inner[59] = randomUUID().toUpperCase();
  inner[61] = []; inner[68] = 2;

  if (needsImageEnvelope) {
    // Common to attachments + image gen (captured from live web UI HARs).
    inner[3] = `!${randomBytes(1910).toString("base64url")}`;
    inner[4] = randomUUID().replace(/-/g, "");
    inner[79] = 1;
    inner[91] = 0;
    // Image-generation-only flags.
    if (imageGeneration) {
      inner[41] = [1];
      inner[49] = 14;
    }
  } else {
    inner[41] = [1];
  }

  return JSON.stringify([null, JSON.stringify(inner)]);
}

// --- Response parsing -------------------------------------------------------

function trimEnvelope(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("Gemini response did not contain a JSON payload.");
  return text.slice(start, end + 1);
}

/** Parse a StreamGenerate body into a flat list of "parts" (handles rt=c framing + legacy). */
function parseResponseParts(rawText) {
  let content = rawText;
  if (content.startsWith(")]}'")) content = content.slice(4);
  content = content.replace(/^[\s\n]+/, "");
  if (/^\d+\n/.test(content)) {
    const parts = [];
    let pos = 0;
    while (pos < content.length) {
      while (pos < content.length && /\s/.test(content[pos])) pos++;
      if (pos >= content.length) break;
      const m = /^(\d+)\n/.exec(content.slice(pos));
      if (!m) break;
      const length = parseInt(m[1], 10);
      if (!Number.isFinite(length)) break;
      const frameStart = pos + m[1].length;
      const chunk = content.slice(frameStart, frameStart + length);
      pos = frameStart + length;
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) parts.push(...parsed); else parts.push(parsed);
      } catch { /* ignore unparseable frames */ }
    }
    if (parts.length > 0) return parts;
  }
  return JSON.parse(trimEnvelope(content));
}

function extractErrorCode(parts) {
  const code = getNested(parts, [0, 5, 2, 0, 1, 0], -1);
  return typeof code === "number" && code >= 0 ? code : undefined;
}

export function parseResponse(rawText) {
  const parts = parseResponseParts(rawText);
  const errorCode = extractErrorCode(parts);
  let bodyIndex = 0;
  let body = null;
  // A candidate text that's just a googleusercontent.com placeholder URL is not a
  // real answer (it shows up in early "analyzing" frames) — keep scanning for a
  // part whose candidate has actual prose.
  const isPlaceholderText = (t) =>
    typeof t !== "string" ||
    t.length === 0 ||
    /^http:\/\/googleusercontent\.com\/(card_content|image_generation_content)\//.test(t);
  for (let i = 0; i < parts.length; i++) {
    const partBody = getNested(parts[i], [2], null);
    if (!partBody) continue;
    try {
      const parsed = JSON.parse(partBody);
      const candidates = getNested(parsed, [4], []);
      if (Array.isArray(candidates) && candidates.length > 0) {
        const text = getNested(candidates[0], [1, 0], "");
        if (body === null) { bodyIndex = i; body = parsed; }
        if (!isPlaceholderText(text)) body = parsed;
      }
    } catch { /* ignore */ }
  }
  const firstCandidate = getNested(body, [4, 0], null);
  const textRaw = getNested(firstCandidate, [1, 0], "");
  const isContentUrl = /^http:\/\/googleusercontent\.com\/(card_content|image_generation_content)\//.test(textRaw);
  const text = isContentUrl ? (getNested(firstCandidate, [22, 0], null) ?? textRaw) : textRaw;
  const thoughts = getNested(firstCandidate, [37, 0, 0], null);
  const metadata = getNested(body, [1], []);
  const images = [];
  for (const webImage of getNested(firstCandidate, [12, 1], [])) {
    const url = getNested(webImage, [0, 0, 0], null);
    if (url) images.push({ kind: "web", url, title: getNested(webImage, [7, 0], undefined), alt: getNested(webImage, [0, 4], undefined) });
  }
  const hasGenerated = Boolean(getNested(firstCandidate, [12, 7, 0], null));
  if (hasGenerated) {
    let imgBody = null;
    for (let i = bodyIndex; i < parts.length; i++) {
      const partBody = getNested(parts[i], [2], null);
      if (!partBody) continue;
      try {
        const parsed = JSON.parse(partBody);
        if (getNested(parsed, [4, 0, 12, 7, 0], null) != null) { imgBody = parsed; break; }
      } catch { /* ignore */ }
    }
    for (const gen of getNested(getNested(imgBody ?? body, [4, 0], null), [12, 7, 0], [])) {
      const url = getNested(gen, [0, 3, 3], null);
      if (url) images.push({ kind: "generated", url, title: "[Generated Image]", alt: "" });
    }
  }
  return { metadata, text, thoughts, images, errorCode };
}

export function isModelUnavailable(errorCode) {
  return errorCode === 1052;
}

// --- Image download ---------------------------------------------------------

function ensureFullSize(url) {
  if (url.includes("=s2048") || url.includes("=s")) return url;
  return `${url}=s2048`;
}

async function fetchPreservingRedirects(url, init, signal, maxRedirects = 10) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, { ...init, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects while downloading image.");
}

async function downloadImage(url, cookieMap, outputPath, signal) {
  const res = await fetchPreservingRedirects(ensureFullSize(url), {
    headers: { cookie: buildCookieHeader(cookieMap), "user-agent": USER_AGENT },
  }, signal);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status} ${res.statusText}`);
  const data = new Uint8Array(await res.arrayBuffer());
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, data);
}

function extractGgdlUrls(rawText) {
  const matches = rawText.match(/https:\/\/lh3\.googleusercontent\.com\/gg-dl\/[^\s"']+/g) ?? [];
  return [...new Set(matches)];
}

export async function saveFirstImage(output, cookieMap, outputPath, signal) {
  const pick = output.images.find((i) => i.kind === "generated") ?? output.images[0];
  if (pick?.url) {
    await downloadImage(pick.url, cookieMap, outputPath, signal);
    return { saved: true, imageCount: output.images.length };
  }
  const ggdl = extractGgdlUrls(output.rawResponseText ?? "");
  if (ggdl[0]) {
    await downloadImage(ggdl[0], cookieMap, outputPath, signal);
    return { saved: true, imageCount: ggdl.length };
  }
  return { saved: false, imageCount: 0 };
}

// --- The main run -----------------------------------------------------------

/**
 * Run one Gemini web turn.
 * @param {{ prompt: string, files?: string[], model: string, cookieMap: Record<string,string>, chatMetadata?: unknown, signal?: AbortSignal, imageGeneration?: boolean }} input
 */
export async function runOnce(input) {
  const cookieHeader = buildCookieHeader(input.cookieMap);
  const bootstrap = { at: undefined, buildLabel: undefined, sessionId: undefined };
  const { at, buildLabel, sessionId } = await fetchSessionBootstrap(input.cookieMap, input.signal);
  Object.assign(bootstrap, { at, buildLabel, sessionId });

  // Warmup: the web UI sends a BARD_SETTINGS activity RPC before upload/generate.
  if ((input.files?.length ?? 0) > 0 || input.imageGeneration) {
    await sendBardActivity(input.cookieMap, bootstrap, input.signal);
  }

  const uploaded = [];
  for (const file of input.files ?? []) {
    if (input.signal?.aborted) throw new Error("Aborted before upload.");
    uploaded.push(await uploadFile(file, input.signal));
  }

  const needsImageEnvelope = Boolean(input.imageGeneration) || (input.files?.length ?? 0) > 0;
  const fReq = buildFReqPayload(input.prompt, uploaded, input.chatMetadata ?? null, "en", needsImageEnvelope);
  const requestUuid = randomUUID().toUpperCase();
  const params = new URLSearchParams();
  params.set("at", at); params.set("f.req", fReq); params.set("hl", "en");
  params.set("_reqid", String(Math.floor(Math.random() * 90_000) + 10_000));
  params.set("rt", "c"); // streaming frames
  if (buildLabel) params.set("bl", buildLabel);
  if (sessionId) params.set("f.sid", sessionId);

  const modelHeaders = buildModelHeaders(input.model, { imageGeneration: needsImageEnvelope, requestUuid });
  const res = await fetch(GEMINI_STREAM_URL, {
    method: "POST", redirect: "follow", signal: input.signal,
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      origin: "https://gemini.google.com", referer: "https://gemini.google.com/",
      "x-same-domain": "1", "user-agent": USER_AGENT, cookie: cookieHeader,
      ...modelHeaders,
      "x-goog-ext-525005358-jspb": JSON.stringify([requestUuid, 1]),
    },
    body: params.toString(),
  });

  // Stream the response body fully — rt=c streams incrementally and the
  // candidate text arrives in later frames, so we must drain the whole stream.
  let rawResponseText = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawResponseText += decoder.decode(value, { stream: true });
    }
    rawResponseText += decoder.decode();
  } else {
    rawResponseText = await res.text();
  }
  if (!res.ok) {
    return { rawResponseText, text: "", thoughts: null, metadata: input.chatMetadata ?? null, images: [], errorMessage: `Gemini request failed: ${res.status} ${res.statusText}` };
  }
  try {
    const parsed = parseResponse(rawResponseText);
    return { rawResponseText, text: parsed.text ?? "", thoughts: parsed.thoughts, metadata: parsed.metadata, images: parsed.images, errorCode: parsed.errorCode };
  } catch (error) {
    let parts = null;
    try { parts = parseResponseParts(rawResponseText); } catch { parts = null; }
    return {
      rawResponseText, text: "", thoughts: null, metadata: input.chatMetadata ?? null, images: [],
      errorCode: extractErrorCode(parts), errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Run with automatic fallback to flash-lite if the requested model is unavailable (error 1052). */
export async function runWithFallback(input) {
  const attempt = await runOnce(input);
  if (isModelUnavailable(attempt.errorCode) && input.model !== FALLBACK_MODEL) {
    const fallback = await runOnce({ ...input, model: FALLBACK_MODEL });
    return { ...fallback, effectiveModel: FALLBACK_MODEL };
  }
  return { ...attempt, effectiveModel: input.model };
}
