require("dotenv").config();

const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpeg = require("fluent-ffmpeg");
const mime = require("mime-types");
const axios = require("axios");
const { Writer } = require("wav");
const {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
} = require("@discordjs/voice");
const prism = require("prism-media");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require("discord.js");
const OpenAI = require("openai");

// ---------- Setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

console.log(
  "[Kojo] Target VC:",
  process.env.VOICE_CHANNEL_ID
    ? `ID=${process.env.VOICE_CHANNEL_ID}`
    : process.env.VOICE_CHANNEL_NAME
    ? `NAME=${process.env.VOICE_CHANNEL_NAME}`
    : "NOT SET"
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_CHANNEL_ID = process.env.MOD_CHANNEL_ID || null;

// ---------- Core Schema/Policy/Helpers ----------
function cleanJSONResponse(s) {
  if (typeof s !== "string") return s;
  const fence = s.match(/\{[\s\S]*\}/);
  return fence ? fence[0] : s.trim();
}

function normalizeModeration(raw) {
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    obj = {};
  }
  if (typeof obj !== "object" || obj === null) obj = {};
  if (typeof obj.safe !== "boolean") obj.safe = false;
  if (!obj.version) obj.version = "1.0";
  if (!obj.category) obj.category = "other";
  if (!obj.suggested_action)
    obj.suggested_action = obj.safe ? "allow" : "delete";
  if (!obj.severity) {
    obj.severity =
      {
        ban: "critical",
        kick: "high",
        timeout_1h: "high",
        timeout_10m: "medium",
        delete: "medium",
        warn: "low",
        allow: "low",
      }[obj.suggested_action] || (obj.safe ? "low" : "medium");
  }
  if (typeof obj.confidence !== "number")
    obj.confidence = obj.safe ? 0.6 : 0.85;
  if (!obj.rationale) obj.rationale = "normalized";
  return obj;
}

const ACTION_POLICY = {
  grooming: { severity: "critical", action: "ban" },
  personal_info_solicitation: { severity: "high", action: "ban" },
  sexual_content: { severity: "high", action: "kick" },
  hate_harassment: { severity: "high", action: "kick" }, // direct insults → kick
  violent_content: { severity: "high", action: "kick" },
  scams_malware: { severity: "high", action: "kick" },
  self_harm: { severity: "high", action: "timeout_1h" },
  drugs_alcohol_gambling: { severity: "medium", action: "delete" },
  dangerous_acts: { severity: "medium", action: "delete" },
  profanity: { severity: "low", action: "warn" }, // can change to kick if you want
  other: { severity: "medium", action: "delete" },
};

function decideAction(ai) {
  const policy = ACTION_POLICY[ai.category] || ACTION_POLICY.other;
  if (ai.safe && ai.confidence < 0.55)
    return { severity: "medium", action: "delete", reason: "low_confidence" };
  if (!ai.safe) return policy;
  return { severity: "low", action: "allow" };
}

function riskyPIIHeuristic(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const keywords = [
    "home address",
    "address",
    "phone number",
    "whatsapp",
    "snapchat",
    "telegram",
    "send pics",
    "nudes",
    "meet up",
    "where do you live",
    "what school",
    "which school",
    "class schedule",
    "come to my",
    "dm me privately",
    "move to",
  ];
  return keywords.some((k) => t.includes(k));
}

// ---------- Moderation Functions ----------
async function moderateText(content, context = "") {
  if (!content || !content.trim()) {
    return normalizeModeration({
      safe: true,
      suggested_action: "allow",
      category: "other",
      confidence: 0.95,
    });
  }

  const systemPrompt = `
You are Kojo, an AI moderator protecting children/teens (<17) on Discord.

Return ONLY this JSON (no prose, no code fences):
{
  "version":"1.0",
  "safe": true|false,
  "confidence": number (0..1),
  "category": "none | profanity | sexual_content | grooming | self_harm | hate_harassment | violent_content | personal_info_solicitation | scams_malware | dangerous_acts | drugs_alcohol_gambling | other",
  "severity": "low | medium | high | critical",
  "suggested_action": "allow | warn | delete | timeout_10m | timeout_1h | kick | ban",
  "rationale": "short machine-readable reason"
}

Definitions:
- grooming: attempts by an older user to build trust with a minor for sexual or exploitative intent, including requests for private contact, sharing personal info, meeting IRL, sexual talk, or sending/asking sexual images.
- personal_info_solicitation: asking for or prompting disclosure of home address, school name, class schedule, phone number, email, social handles, geolocation, recurring routes, or other identifying info.
- hate_harassment: direct insults or demeaning/abusive language targeted at a person or group (e.g., "go f*** yourself", "you are worthless") — classify these as hate_harassment (not merely profanity).

Rules:
1) grooming and personal_info_solicitation ALWAYS override others; both should be unsafe. Grooming → severity "critical", suggested_action "ban". PII solicitation → "high", "ban".
2) Direct insults → category "hate_harassment", severity "high", suggested_action "kick".
3) If ambiguous but risky toward grooming/PII, unsafe with severity "high".
  `.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      max_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Context: ${context || "N/A"}\nMessage: ${content}`,
        },
      ],
    });

    const raw = cleanJSONResponse(r.choices?.[0]?.message?.content || "");
    return normalizeModeration(raw);
  } catch (e) {
    console.error("moderateText error:", e);
    if (riskyPIIHeuristic(content)) {
      return normalizeModeration({
        safe: false,
        category: "personal_info_solicitation",
        severity: "high",
        suggested_action: "ban",
        rationale: "fallback_pii_heuristic",
      });
    }
    return normalizeModeration({
      safe: false,
      category: "other",
      severity: "medium",
      suggested_action: "delete",
      rationale: "analysis_unavailable",
    });
  }
}

async function moderateURL(url, context = "") {
  try {
    let finalURL = url;
    try {
      const head = await axios.get(url, {
        maxRedirects: 1,
        validateStatus: () => true,
        timeout: 5000,
      });
      if (head?.request?.res?.responseUrl)
        finalURL = head.request.res.responseUrl;
    } catch {}
    const systemPrompt = `
You are Kojo, an AI moderator. Classify the RISK of a URL for a Discord server.

Return ONLY this JSON:
{"version":"1.0","safe":true|false,"confidence":0..1,"category":"scams_malware | sexual_content | grooming | personal_info_solicitation | hate_harassment | violent_content | other | none","severity":"low | medium | high | critical","suggested_action":"allow | warn | delete | timeout_10m | timeout_1h | kick | ban","rationale":"short"}
Rules:
- Phishing/malware/crypto scam → scams_malware, severity "high", action "kick".
- Pornographic or sexualized minors → sexual_content or grooming, severity "critical", action "ban".
- URLs soliciting personal info → personal_info_solicitation, severity "high", action "ban".
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      max_tokens: 160,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Context: ${context || "N/A"}\nURL: ${finalURL}`,
        },
      ],
    });

    const raw = cleanJSONResponse(r.choices?.[0]?.message?.content || "");
    return normalizeModeration(raw);
  } catch (e) {
    console.error("moderateURL error:", e);
    return normalizeModeration({
      safe: false,
      category: "other",
      severity: "medium",
      suggested_action: "delete",
      rationale: "analysis_unavailable",
    });
  }
}

async function moderateImage(imageUrl) {
  const systemPrompt = `
You are Kojo, an AI moderator for images.

Return ONLY this JSON:
{"version":"1.0","safe":true|false,"confidence":0..1,"category":"none | sexual_content | grooming | violent_content | hate_harassment | scams_malware | drugs_alcohol_gambling | dangerous_acts | other","severity":"low | medium | high | critical","suggested_action":"allow | warn | delete | timeout_10m | timeout_1h | kick | ban","rationale":"short"}
Rules:
- Sexual content (pin-ups, implied sex acts) → "sexual_content". If minors/childlike figures: "grooming", severity "critical", action "ban".
- Obvious violence (fighting, blood) → "violent_content", severity "high", action "kick".
- Hate symbols/slurs → "hate_harassment", severity "high", action "kick".
`.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      max_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this image for policy risk and output ONLY the JSON.",
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    const raw = cleanJSONResponse(r.choices?.[0]?.message?.content || "");
    return normalizeModeration(raw);
  } catch (e) {
    console.error("moderateImage error:", e);
    return normalizeModeration({
      safe: false,
      category: "other",
      severity: "medium",
      suggested_action: "delete",
      rationale: "image_analysis_unavailable",
    });
  }
}

async function moderateVideo(videoUrl, filename = "") {
  const systemPrompt = `
You are Kojo, an AI moderator. Classify video risk based on URL/filename/context.

Return ONLY this JSON:
{"version":"1.0","safe":true|false,"confidence":0..1,"category":"none | sexual_content | grooming | violent_content | hate_harassment | scams_malware | dangerous_acts | drugs_alcohol_gambling | other","severity":"low | medium | high | critical","suggested_action":"allow | warn | delete | timeout_10m | timeout_1h | kick | ban","rationale":"short"}
Rules:
- Obvious violent fight scenes → "violent_content", severity "high", action "kick".
- Sexual content/nudity → "sexual_content", severity depends on explicitness.
- If analysis is ambiguous, err unsafe with severity "medium".
`.trim();

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.0,
      max_tokens: 180,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Video URL: ${videoUrl}\nFilename: ${
            filename || "N/A"
          }\nContext: Discord attachment.\nClassify risk.`,
        },
      ],
    });

    const raw = cleanJSONResponse(r.choices?.[0]?.message?.content || "");
    return normalizeModeration(raw);
  } catch (e) {
    console.error("moderateVideo error:", e);
    return normalizeModeration({
      safe: false,
      category: "other",
      severity: "medium",
      suggested_action: "delete",
      rationale: "video_analysis_unavailable",
    });
  }
}

// Frame-based video moderation using ffmpeg + moderateImage
async function moderateVideoFromFrames(videoUrl, filename = "") {
  const tmpDir = os.tmpdir();
  const localPath = `${tmpDir}/kojo_vid_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}${path.extname(filename || ".mp4")}`;
  const framesDir = `${tmpDir}/kojo_frames_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    const resp = await axios.get(videoUrl, {
      responseType: "arraybuffer",
      timeout: 20000,
    });
    fs.writeFileSync(localPath, Buffer.from(resp.data));

    const durationSec = await new Promise((resolve) => {
      ffmpeg.ffprobe(localPath, (err, data) => {
        if (err) return resolve(null);
        const d = data?.format?.duration;
        resolve(
          typeof d === "number"
            ? d
            : typeof d === "string"
            ? parseFloat(d)
            : null
        );
      });
    });

    if (durationSec && durationSec > 0) {
      const pts = [0.1, 0.5, 0.9].map((p) =>
        Math.max(0.0, Math.min(durationSec - 0.1, durationSec * p))
      );
      await Promise.all(
        pts.map(
          (t, i) =>
            new Promise((res, rej) => {
              ffmpeg(localPath)
                .seekInput(t)
                .frames(1)
                .output(path.join(framesDir, `f${i + 1}.jpg`))
                .on("end", res)
                .on("error", rej)
                .run();
            })
        )
      );
    } else {
      await new Promise((res, rej) => {
        ffmpeg(localPath)
          .outputOptions(["-vf", "fps=1"])
          .output(path.join(framesDir, "f%02d.jpg"))
          .on("end", res)
          .on("error", rej)
          .run();
      });
    }

    const files = fs
      .readdirSync(framesDir)
      .filter((f) => /\.jpe?g$/i.test(f))
      .slice(0, 4);
    if (!files.length) throw new Error("No frames extracted");

    const results = [];
    for (const f of files) {
      const p = path.join(framesDir, f);
      const b = fs.readFileSync(p);
      const dataUrl = `data:image/jpeg;base64,${b.toString("base64")}`;
      const ai = await moderateImage(dataUrl);
      results.push(ai);
    }

    const rank = { critical: 3, high: 2, medium: 1, low: 0 };
    let worst = results[0];
    for (const r of results.slice(1)) {
      if ((rank[r.severity] ?? 0) > (rank[worst.severity] ?? 0)) worst = r;
    }
    worst.rationale =
      (worst.rationale || "frame_based") + `_frames:${files.length}`;
    return worst;
  } catch (e) {
    console.error("moderateVideoFromFrames error:", e);
    return await moderateVideo(videoUrl, filename);
  } finally {
    try {
      fs.rmSync(framesDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.unlinkSync(localPath);
    } catch {}
  }
}

// ---------- Logging ----------
async function postModLog({
  userId,
  userTag,
  channelId,
  category,
  severity,
  action,
  confidence,
  rationale,
  enforcementNote,
  contentPreview,
  link,
}) {
  if (!MOD_CHANNEL_ID) return;
  const ch = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle("Kojo Moderation Event")
    .setColor(
      severity === "critical"
        ? 0xff0033
        : severity === "high"
        ? 0xff6600
        : severity === "medium"
        ? 0xffcc00
        : 0x00cc66
    )
    .addFields(
      {
        name: "User",
        value: userTag ? `${userTag} (${userId})` : userId || "Unknown",
        inline: false,
      },
      {
        name: "Channel",
        value: channelId ? `<#${channelId}>` : "Unknown",
        inline: true,
      },
      { name: "Category", value: category || "N/A", inline: true },
      { name: "Severity", value: severity || "N/A", inline: true },
      { name: "Action", value: action || "N/A", inline: true },
      { name: "Confidence", value: String(confidence ?? "N/A"), inline: true },
      { name: "Rationale", value: rationale || "N/A", inline: false }
    );

  if (enforcementNote)
    embed.addFields({
      name: "Enforcement Note",
      value: enforcementNote,
      inline: false,
    });
  if (contentPreview)
    embed.addFields({
      name: "Content (preview)",
      value: "```" + contentPreview.slice(0, 400) + "```",
      inline: false,
    });
  if (link) embed.addFields({ name: "Link", value: link, inline: false });

  await ch.send({ embeds: [embed] }).catch(() => {});
}

async function enforcePunishment(member, action, reason) {
  try {
    switch (action) {
      case "ban":
        if (member?.bannable) {
          await member.ban({ reason: `Kojo: ${reason}` });
          return { applied: true };
        }
        if (member?.kickable) {
          await member.kick(`Kojo: ${reason}`);
          return { applied: true, note: "kick fallback" };
        }
        if (member?.moderatable) {
          await member.timeout(60 * 60 * 1000, `Kojo: ${reason}`);
          return { applied: true, note: "timeout fallback" };
        }
        return { applied: false, note: "not bannable/kickable/moderatable" };

      case "kick":
        if (member?.kickable) {
          await member.kick(`Kojo: ${reason}`);
          return { applied: true };
        }
        if (member?.moderatable) {
          await member.timeout(60 * 60 * 1000, `Kojo: ${reason}`);
          return { applied: true, note: "timeout fallback" };
        }
        return { applied: false, note: "not kickable/moderatable" };

      case "timeout_1h":
        if (member?.moderatable) {
          await member.timeout(60 * 60 * 1000, `Kojo: ${reason}`);
          return { applied: true };
        }
        return { applied: false, note: "not moderatable" };

      case "timeout_10m":
        if (member?.moderatable) {
          await member.timeout(10 * 60 * 1000, `Kojo: ${reason}`);
          return { applied: true };
        }
        return { applied: false, note: "not moderatable" };

      case "delete":
      case "warn":
      case "allow":
      default:
        return { applied: true };
    }
  } catch (e) {
    console.error("enforcePunishment error:", e);
    return { applied: false, note: String(e?.message || e) };
  }
}

// ---------- Apply Moderation ----------
async function applyModeration(message, ai) {
  const decision = decideAction(ai);

  if (decision.action !== "allow") {
    try {
      if (message?.deletable) await message.delete().catch(() => {});
    } catch {}
  }

  const member =
    message?.member ||
    (message?.guild
      ? await message.guild.members.fetch(message.author.id).catch(() => null)
      : null);
  const enforcement = await enforcePunishment(
    member,
    decision.action,
    ai.category
  );

  try {
    await postModLog({
      userId: message.author?.id || member?.id || "unknown",
      userTag: message.author?.tag || member?.user?.tag || "unknown",
      channelId: message.channel?.id || null,
      category: ai.category,
      severity: ai.severity,
      action: decision.action,
      confidence: ai.confidence,
      rationale: ai.rationale,
      enforcementNote: enforcement.note || null,
      contentPreview: message.content?.slice(0, 400) || "",
      link: message.url || null,
    });
  } catch (e) {
    console.error("postModLog error:", e);
  }

  return { decision, enforcement };
}

// ---------- Message Handler ----------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const text = message.content || "";

    // Text
    if (text.trim()) {
      const ai = await moderateText(
        text,
        `guild=${message.guild?.id || "DM"} channel=${
          message.channel?.id || "N/A"
        }`
      );
      if (!ai.safe || ai.severity !== "low") {
        await applyModeration(message, ai);
        return;
      }
    }

    // URL
    const urls = Array.from(text.matchAll(/https?:\/\/\S+/gi)).map((m) => m[0]);
    if (urls.length) {
      const aiURL = await moderateURL(
        urls[0],
        `guild=${message.guild?.id || "DM"} channel=${
          message.channel?.id || "N/A"
        }`
      );
      if (!aiURL.safe || aiURL.severity !== "low") {
        await applyModeration(message, aiURL);
        return;
      }
    }

    // Attachments (image/video)
    if (message.attachments?.size) {
      for (const att of message.attachments.values()) {
        const url = att.url || att.attachment || "";
        const name = att.name || "";
        const ct = (att.contentType || "").toLowerCase();

        const byMimeImage = ct.startsWith("image/");
        const byMimeVideo = ct.startsWith("video/");
        const cleanPath = (() => {
          try {
            return new URL(url).pathname;
          } catch {
            return url.split("?")[0];
          }
        })().toLowerCase();
        const byNameImage = /\.(png|jpe?g|gif|webp|bmp|tiff)$/i.test(name);
        const byNameVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(name);
        const byUrlImage = /\.(png|jpe?g|gif|webp|bmp|tiff)$/i.test(cleanPath);
        const byUrlVideo = /\.(mp4|mov|webm|mkv|avi)$/i.test(cleanPath);

        const isImage = byMimeImage || byNameImage || byUrlImage;
        const isVideo = byMimeVideo || byNameVideo || byUrlVideo;

        let aiMedia = null;

        if (isImage) {
          aiMedia = await moderateImage(url);
        } else if (isVideo) {
          try {
            aiMedia = await moderateVideoFromFrames(url, name);
          } catch (e) {
            console.error(
              "moderateVideoFromFrames failed, falling back:",
              e?.message || e
            );
            aiMedia = await moderateVideo(url, name);
          }
        } else {
          continue;
        }

        const aiNorm = normalizeModeration(aiMedia);
        if (!aiNorm.safe || aiNorm.severity !== "low") {
          await applyModeration(message, aiNorm);
          return;
        }
      }
    }
  } catch (e) {
    console.error("messageCreate error:", e);
  }
});

// ---------- Manual Voice Commands (optional) ----------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!joinvoice")) return;
  if (!message.member?.voice?.channel)
    return void message.reply("Join a voice channel first.");

  try {
    const connection = joinVoiceChannel({
      channelId: message.member.voice.channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    message.reply("🎧 Joined voice channel. Listening…");

    const receiver = connection.receiver;
    receiver.speaking.on("start", async (userId) => {
      const member = await message.guild.members
        .fetch(userId)
        .catch(() => null);
      if (!member || member.user.bot) return;

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      });

      const outDir = path.join(__dirname, "logs");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, `vc-${userId}-${Date.now()}`);
      const wavPath = `${base}.wav`;

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });
      const wavWriter = new Writer({
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });
      const file = fs.createWriteStream(wavPath);

      opusStream.pipe(decoder).pipe(wavWriter).pipe(file);

      file.on("finish", async () => {
        try {
          const tr = await openai.audio.transcriptions.create({
            file: fs.createReadStream(wavPath),
            model: "whisper-1",
          });
          const text = (tr.text || "").trim();
          if (text.length > 2) {
            const ai = await moderateText(
              text,
              `voice_channel=${message.member.voice.channel.id}`
            );
            if (!ai.safe || ai.severity !== "low") {
              await applyModeration(
                { ...message, content: text, member, author: member.user },
                ai
              );
            }
          }
        } catch (err) {
          console.error("Whisper/STT error:", err);
        } finally {
          fs.unlink(wavPath, () => {});
        }
      });
    });
  } catch (e) {
    console.error("joinvoice error:", e);
    message.reply("Couldn’t join voice: " + (e?.message || e));
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!leavevoice")) return;
  const conn = getVoiceConnection(message.guild.id);
  if (conn) {
    conn.destroy();
    message.reply("👋 Left the voice channel.");
  } else {
    message.reply("I’m not in a voice channel.");
  }
});

// ---------- Auto Voice Moderation (join on join, leave when empty) ----------
const voiceSessions = new Map();
const TARGET_VC_ID = process.env.VOICE_CHANNEL_ID || null;
const TARGET_VC_NAME = process.env.VOICE_CHANNEL_NAME || null;
const MIN_GAP_MS = 1500; // per-user debounce, a bit snappier

function resolveTargetVc(guild) {
  if (!guild) return null;
  if (TARGET_VC_ID) return guild.channels.cache.get(TARGET_VC_ID) || null;
  if (TARGET_VC_NAME) {
    return (
      guild.channels.cache.find(
        (c) =>
          c.type === 2 && c.name.toLowerCase() === TARGET_VC_NAME.toLowerCase()
      ) || null
    );
  }
  return null;
}

async function ensureVoiceJoined(newState) {
  const guild = newState.guild;
  const target = resolveTargetVc(guild);
  if (!target) {
    console.log("[Kojo Voice] No target VC resolved.");
    return;
  }
  if (newState.channelId !== target.id) {
    /* joined different VC */ return;
  }
  if (getVoiceConnection(guild.id)) {
    /* already in */ return;
  }

  const connection = joinVoiceChannel({
    channelId: target.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  const receiver = connection.receiver;
  voiceSessions.set(guild.id, {
    channelId: target.id,
    connection,
    receiver,
    perUserDebounce: new Map(),
  });
  console.log(`[Kojo Voice] Joined VC "${target.name}" in guild ${guild.name}`);

  receiver.speaking.on("start", async (userId) => {
    try {
      const session = voiceSessions.get(guild.id);
      if (!session) return;

      const now = Date.now();
      const last = session.perUserDebounce.get(userId) || 0;
      if (now - last < MIN_GAP_MS) return;
      session.perUserDebounce.set(userId, now);

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member || member.user.bot) return;

      const opus = session.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 900 },
      });

      const outDir = path.join(__dirname, "logs");
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, `vc-${guild.id}-${userId}-${Date.now()}`);
      const wavPath = `${base}.wav`;

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });
      const wavWriter = new Writer({
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });
      const file = fs.createWriteStream(wavPath);

      opus.pipe(decoder).pipe(wavWriter).pipe(file);

      file.on("finish", async () => {
        try {
          const tr = await openai.audio.transcriptions.create({
            file: fs.createReadStream(wavPath),
            model: "whisper-1",
          });
          const text = (tr.text || "").trim();
          if (text.length > 2) {
            const ai = await moderateText(
              text,
              `voice_channel=${session.channelId}`
            );
            if (!ai.safe || ai.severity !== "low") {
              await applyModeration(
                {
                  guild,
                  content: text,
                  member,
                  author: member.user,
                  channel: resolveTargetVc(guild),
                },
                ai
              );
            }
          }
        } catch (err) {
          console.error(
            "[Kojo Voice] Whisper/moderation error:",
            err?.message || err
          );
        } finally {
          fs.unlink(wavPath, () => {});
        }
      });
    } catch (e) {
      console.error("[Kojo Voice] speaking handler error:", e?.message || e);
    }
  });
}

async function maybeLeaveIfEmpty(oldState, newState) {
  const guild = (oldState && oldState.guild) || (newState && newState.guild);
  if (!guild) return;
  const session = voiceSessions.get(guild.id);
  if (!session) return;

  const channel = guild.channels.cache.get(session.channelId);
  if (!channel) {
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.destroy();
    voiceSessions.delete(guild.id);
    console.log("[Kojo Voice] Left VC (channel missing).");
    return;
  }

  // Count humans
  const humans = [...channel.members.values()].filter((m) => !m.user.bot);
  console.log(
    `[Kojo Voice] VC "${channel.name}" humans=${humans.length}, total=${channel.members.size}`
  );
  if (humans.length === 0) {
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.destroy();
    voiceSessions.delete(guild.id);
    console.log(`[Kojo Voice] Left VC "${channel.name}" (no humans).`);
  }
}

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    if (!oldState.channelId && newState.channelId) {
      await ensureVoiceJoined(newState);
      return;
    }
    if (
      oldState.channelId &&
      newState.channelId &&
      oldState.channelId !== newState.channelId
    ) {
      await ensureVoiceJoined(newState);
    }
    await maybeLeaveIfEmpty(oldState, newState);
  } catch (e) {
    console.error("[Kojo Voice] voiceStateUpdate error:", e?.message || e);
  }
});

// ---------- Ready / Login ----------
client.once("clientReady", () => {
  console.log(`Kojo is online as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
