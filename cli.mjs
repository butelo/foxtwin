#!/usr/bin/env node
/**
 * foxtwin — talk to gemini.google.com using your Firefox cookies. No API key.
 *
 * Usage:
 *   node cli.mjs "your prompt"
 *   node cli.mjs --generate-image out.jpg "a cute robot holding a banana"
 *   node cli.mjs --edit-image in.png --output out.jpg "add sunglasses"
 *
 * Options:
 *   --model <id>            gemini-3.1-pro (default) | gemini-3.5-flash | gemini-3.1-flash-lite | gemini-3-deep-think
 *   --profile <dir|name>    Firefox profile dir or name (auto-detected otherwise)
 *   --container <id>        Firefox Multi-Account Container userContextId (e.g. "2" for your Pro account)
 *   --generate-image <path> write a generated image to this path
 *   --edit-image <path>     input image to edit
 *   --output <path>         output path for edited images
 *   --aspect <ratio>        aspect ratio hint, e.g. "1:1" (image gen)
 *   --show-thoughts         include the model's thinking in output
 *   --file <path>           attach a file (image/pdf) to the prompt; repeatable
 *
 * Env (fallbacks for the above): GEMINI_MODEL, FIREFOX_PROFILE, FIREFOX_CONTAINER
 *
 * Requires Node 22+ (uses built-in node:sqlite). Zero external dependencies.
 */
import process from "node:process";
import { resolveFirefoxProfile, loadGeminiCookiesFromFirefox, hasRequiredGeminiCookies } from "./src/firefoxCookies.mjs";
import { resolveModel, DEFAULT_MODEL, runWithFallback, saveFirstImage } from "./src/gemini.mjs";

function parseArgs(argv) {
  const opts = { files: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--model": opts.model = argv[++i]; break;
      case "--profile": opts.profile = argv[++i]; break;
      case "--container": opts.container = argv[++i]; break;
      case "--generate-image": opts.generateImage = argv[++i]; break;
      case "--edit-image": opts.editImage = argv[++i]; break;
      case "--output": opts.output = argv[++i]; break;
      case "--aspect": opts.aspect = argv[++i]; break;
      case "--show-thoughts": opts.showThoughts = true; break;
      case "--file": opts.files.push(argv[++i]); break;
      case "-h": case "--help": opts.help = true; break;
      default: opts.positional.push(a);
    }
  }
  return opts;
}

const HELP = `foxtwin — talk to gemini.google.com using your Firefox cookies.

Usage:
  node cli.mjs "your prompt"
  node cli.mjs --generate-image out.jpg "a cute robot holding a banana"
  node cli.mjs --container 2 --generate-image out.jpg "..."   (use Pro account)
  node cli.mjs --edit-image in.png --output out.jpg "add sunglasses"

Options:
  --model <id>            gemini-3.1-pro | gemini-3.5-flash | gemini-3.1-flash-lite
  --profile <dir|name>    Firefox profile (auto-detected otherwise)
  --container <id>        Firefox container userContextId (e.g. "2")
  --generate-image <path> write a generated image to this path
  --edit-image <path>     input image to edit
  --output <path>         output path for edited images
  --aspect <ratio>        aspect ratio hint (e.g. "1:1")
  --show-thoughts         include the model's thinking
  --file <path>           attach a file (repeatable)

Env: GEMINI_MODEL, FIREFOX_PROFILE, FIREFOX_CONTAINER
Requires Node 22+. Zero dependencies.`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const prompt = opts.positional.join(" ").trim();
  if (!prompt) { console.error("Error: no prompt provided.\n\n" + HELP); process.exit(1); }

  const model = resolveModel(opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL);
  const profile = opts.profile ?? process.env.FIREFOX_PROFILE;
  const container = opts.container ?? process.env.FIREFOX_CONTAINER;
  const generateImage = opts.generateImage;
  const editImage = opts.editImage;
  const outputPath = opts.output;
  const showThoughts = Boolean(opts.showThoughts);
  const isImageGen = Boolean(generateImage || editImage);

  const resolved = resolveFirefoxProfile(profile);
  if (!resolved) {
    console.error("No Firefox profile found. Sign into gemini.google.com in Firefox, or pass --profile.");
    process.exit(1);
  }
  console.error(`[firefox] profile: ${resolved.profileDir} (${resolved.source})${container ? ` | container: ${container}` : ""} | model: ${model}`);

  const { cookieMap, warnings } = await loadGeminiCookiesFromFirefox({ firefoxProfile: profile, firefoxContainer: container }, (m) => console.error(m));
  if (warnings.length) console.error(`[firefox] warnings: ${warnings.join("; ")}`);
  if (!hasRequiredGeminiCookies(cookieMap)) {
    console.error("Missing required Google auth cookies (__Secure-1PSID / __Secure-1PSIDTS). Sign into gemini.google.com in this Firefox profile/container first.");
    process.exit(2);
  }

  const controller = new AbortController();
  const timeoutMs = isImageGen ? 300_000 : 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let finalPrompt = prompt;
    if (opts.aspect && isImageGen) finalPrompt = `${prompt} (aspect ratio: ${opts.aspect})`;
    if (generateImage && !editImage) finalPrompt = `Generate an image: ${finalPrompt}`;

    if (editImage) {
      // Edit: first upload the input image, then ask to edit it.
      const intro = await runWithFallback({
        prompt: "Here is an image to edit", files: [editImage], model,
        cookieMap, chatMetadata: null, signal: controller.signal,
      });
      const out = await runWithFallback({
        prompt: `Use image generation tool to ${finalPrompt}`, files: opts.files, model,
        cookieMap, chatMetadata: intro.metadata, signal: controller.signal, imageGeneration: true,
      });
      const savePath = outputPath ?? generateImage ?? "generated.png";
      const saved = await saveFirstImage({ ...out, rawResponseText: out.rawResponseText ?? "" }, cookieMap, savePath, controller.signal);
      if (!saved.saved) throw new Error(`No images generated. Response text:\n${out.text || "(empty)"}`);
      console.error(`Saved edited image to: ${savePath}`);
      return;
    }

    const out = await runWithFallback({
      prompt: finalPrompt, files: opts.files, model,
      cookieMap, chatMetadata: null, signal: controller.signal,
      imageGeneration: Boolean(generateImage),
    });

    if (generateImage) {
      const saved = await saveFirstImage({ ...out, rawResponseText: out.rawResponseText ?? "" }, cookieMap, generateImage, controller.signal);
      if (!saved.saved) throw new Error(`No images generated. Response text:\n${out.text || "(empty)"}`);
      console.error(`Saved generated image to: ${generateImage}`);
      return;
    }

    let answer = out.text || "";
    if (showThoughts && out.thoughts) answer = `## Thinking\n\n${out.thoughts}\n\n## Response\n\n${answer}`;
    process.stdout.write((answer || "(no output)") + "\n");
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
