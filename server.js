require("dotenv").config();
const express = require("express");
const path = require("path");
const OpenAI = require("openai");
const multer = require("multer");
const fs = require("fs");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffprobePath = require("ffprobe-static").path;
ffmpeg.setFfprobePath(ffprobePath);
const ffmpegPath = require("ffmpeg-static");

// Optional QR support (won’t break if not installed)
let QRCode = null;
try {
  QRCode = require("qrcode");
} catch (_) {
  /* optional */
}

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("audio/")
    ) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only images, videos and audio files are allowed for moderation testing."
        )
      );
    }
  },
});

// Middleware
app.use(express.json());
app.use(express.static("public"));

// Helper to clean JSON from OpenAI
function cleanJSONResponse(content) {
  let cleaned = (content || "").trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/```\s*$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/```\s*$/, "");
  }
  return cleaned.trim();
}

// In-memory storage for demo session data
const demoSessions = new Map();
const globalStats = {
  totalMessages: 0,
  messagesModerated: 0,
  imagesAnalyzed: 0,
  videosAnalyzed: 0,
  audioAnalyzed: 0,
  urlsChecked: 0,
  averageResponseTime: 1200,
  voiceAlertsToday: 0,
  patternDetections: 0,
};

/* =========================
   TEXT MODERATION (U17)
   ========================= */
async function moderateTextAdvanced(content, context = "") {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are Kojo, an advanced AI content moderator protecting **children and teens under 17**.
Analyze the user message with comprehensive safety checks.

ALWAYS CHECK FOR:
- Profanity/inappropriate language
- Sexual content/innuendo/romantic solicitations
- Violence, threats, self-harm, or dangerous behavior encouragement
- Bullying/harassment/cyberbullying patterns
- Personal information sharing (addresses, phone numbers, real names, schools)
- Scary/disturbing content
- References to drugs, alcohol, or adult substances
- Attempts to bypass filters
- Mature themes (gambling, adult services, etc.)
- Harmful misinformation

SAFE WEBSITES (do NOT flag these):
- google.com, youtube.com, wikipedia.org, khanacademy.org, scratch.mit.edu
- Educational/news-for-kids sites, gaming sites like minecraft.net

Context: ${context}

If SAFE, respond with a short, friendly, encouraging message.

If UNSAFE, respond with:
"🛡️ MODERATED: This message was removed because [specific, child-friendly reason]. Let's keep our chat safe and fun for everyone! Try talking about something like your favorite games, books, or hobbies instead."`,
        },
        { role: "user", content },
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const kojoResponse = response.choices[0].message.content.trim();
    const isModerated = kojoResponse.includes("🛡️ MODERATED:");

    return {
      response: kojoResponse,
      moderated: isModerated,
      safe: !isModerated,
      confidence: isModerated ? 0.9 : 0.8,
    };
  } catch (error) {
    console.error("Error in advanced text moderation:", error);
    return {
      response:
        "🤖 I'm having some technical difficulties right now. Please try again in a moment!",
      moderated: false,
      safe: true,
      confidence: 0.5,
    };
  }
}

/* =========================
   IMAGE MODERATION (U17)
   ========================= */
async function moderateImageAdvanced(imageBuffer, filename) {
  try {
    const base64Image = imageBuffer.toString("base64");
    const mimeType = filename.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are Kojo, analyzing images for **under-17** safety.

FLAG AS UNSAFE IF:
- Inappropriate/sexual/suggestive content
- Violence, weapons, blood, scary/disturbing imagery
- Dangerous stunts (fire, explosives, reckless behavior)
- Inappropriate text/symbols
- Faces of real children with risky context (privacy/safety)
- Adult products, substances, or mature themes

Respond with either:
- "✅ SAFE: This image looks great! [brief positive comment]"
- "🛡️ UNSAFE: This image was blocked because [specific reason]. Please share appropriate images only."`,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 150,
    });

    const result = response.choices[0].message.content.trim();
    const isUnsafe = result.includes("🛡️ UNSAFE:");

    return {
      response: result,
      safe: !isUnsafe,
      moderated: isUnsafe,
      confidence: 0.85,
    };
  } catch (error) {
    console.error("Error moderating image:", error);
    return {
      response:
        "🤖 I couldn't analyze this image right now. Please try again later!",
      safe: true,
      moderated: false,
      confidence: 0.5,
    };
  }
}

/* =========================
   VIDEO ANALYSIS (U17)
   - more frames
   - hard flags: violence/fire/weapons
   - stricter thresholds
   ========================= */

// Extract frames from video at intervals (stricter: more frames)
function extractVideoFrames(videoPath) {
  return new Promise((resolve) => {
    const frames = [];
    const frameCount = 8; // increased from 5 → stricter
    const framePrefix = `frame-${Date.now()}`;

    for (let i = 1; i <= frameCount; i++) {
      frames.push(path.join("uploads", `${framePrefix}-${i}.jpg`));
    }

    ffmpeg(videoPath)
      .screenshots({
        count: frameCount,
        folder: "uploads",
        filename: `${framePrefix}-%i.jpg`,
        size: "640x480",
      })
      .on("end", () => {
        const existing = frames.filter((p) => fs.existsSync(p));
        resolve(existing);
      })
      .on("error", (err) => {
        console.error("Error extracting frames:", err);
        // Fallback to fewer frames
        ffmpeg(videoPath)
          .outputOptions(["-vf", "fps=1/2", "-vframes", "4"])
          .output(path.join("uploads", `${framePrefix}-%d.jpg`))
          .on("end", () => {
            const existing = [];
            for (let i = 1; i <= 4; i++) {
              const p = path.join("uploads", `${framePrefix}-${i}.jpg`);
              if (fs.existsSync(p)) existing.push(p);
            }
            resolve(existing);
          })
          .on("error", () => resolve([]))
          .run();
      });
  });
}

// Analyze individual video frame (conservative for U17)
async function analyzeVideoFrame(framePath, frameNumber, totalFrames) {
  try {
    const imageBuffer = fs.readFileSync(framePath);
    const base64Image = imageBuffer.toString("base64");

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are Kojo, analyzing video frame ${frameNumber}/${totalFrames} for **under-17** safety.

IMMEDIATELY FLAG as UNSAFE if you see:
- Violence or fighting (even cultural/sport-like)
- Weapons, sticks/bats used to strike, projectiles
- Fire/flames/explosions/dangerous stunts or reckless behavior
- Blood, gore, injury, graphic harm
- Sexual content or nudity
- Drug/alcohol use

Respond in strict JSON:
{"safe": true/false, "confidence": 0.0-1.0, "reason": "short reason"}`,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
      max_tokens: 80,
      temperature: 0.0,
    });

    const result = JSON.parse(
      cleanJSONResponse(response.choices[0].message.content)
    );
    return result;
  } catch (error) {
    console.error("Error analyzing frame:", error);
    return { safe: true, confidence: 0.5, reason: "Analysis failed" };
  }
}

// Main video moderation logic (hard flags + stricter threshold)
async function moderateVideoAdvanced(videoPath, filename) {
  try {
    // quick filename heuristics
    const suspiciousKeywords = [
      "xxx",
      "adult",
      "mature",
      "nsfw",
      "explicit",
      "violence",
      "blood",
      "gore",
      "fight",
      "fighting",
      "weapon",
      "flame",
      "fire",
    ];
    const lowerFilename = filename.toLowerCase();
    for (const keyword of suspiciousKeywords) {
      if (lowerFilename.includes(keyword)) {
        return {
          response: `🛡️ UNSAFE: This video was blocked because the filename contains inappropriate content (${keyword}).`,
          safe: false,
          moderated: true,
          confidence: 0.9,
        };
      }
    }

    // file size guard
    const stats = fs.statSync(videoPath);
    const sizeInMB = stats.size / (1024 * 1024);
    if (sizeInMB > 50) {
      return {
        response:
          "🛡️ UNSAFE: This video file is too large for our child-safe environment. Please share smaller videos.",
        safe: false,
        moderated: true,
        confidence: 0.8,
      };
    }

    // Extract frames
    const frames = await extractVideoFrames(videoPath);
    if (frames.length === 0) {
      // Fallback: conservative filename analysis
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `Assess video safety for under-17s based on filename and size.
Block anything that may depict violence, weapons, or dangerous stunts (e.g., fire play), even if cultural.
Return one sentence starting with either "✅ SAFE:" or "🛡️ UNSAFE:".`,
          },
          {
            role: "user",
            content: `Video: "${filename}", size: ${sizeInMB.toFixed(1)}MB`,
          },
        ],
        max_tokens: 100,
      });
      const result = response.choices[0].message.content.trim();
      const isUnsafe = result.includes("🛡️ UNSAFE:");
      return {
        response: result,
        safe: !isUnsafe,
        moderated: isUnsafe,
        confidence: 0.7,
      };
    }

    // Analyze frames
    let inappropriateFrames = 0;
    let totalConfidence = 0;
    const flaggedReasons = [];

    for (let i = 0; i < frames.length; i++) {
      const frameAnalysis = await analyzeVideoFrame(
        frames[i],
        i + 1,
        frames.length
      );
      if (!frameAnalysis.safe) {
        inappropriateFrames++;
        flaggedReasons.push((frameAnalysis.reason || "").toLowerCase());
      }
      totalConfidence += frameAnalysis.confidence || 0.6;
    }

    // cleanup frames
    frames.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    });

    const avgConfidence = totalConfidence / frames.length;
    const ratio = inappropriateFrames / frames.length;

    // Hard-flag phrases
    const hardFlags =
      /(violence|violent|weapon|fight|fighting|blood|gore|injur|fire|flame|explosion|dangerous|stunt)/i;
    const hasHardFlag = flaggedReasons.some((r) => hardFlags.test(r));

    if (hasHardFlag || ratio > 0.18) {
      const firstReason =
        flaggedReasons[0] || "inappropriate or unsafe content";
      return {
        response: `🛡️ UNSAFE: This video contains ${firstReason}. Please only share child-friendly videos.`,
        safe: false,
        moderated: true,
        confidence: Math.max(0.75, avgConfidence),
      };
    }

    return {
      response: `✅ SAFE: This video appears child-appropriate. I checked ${frames.length} frames.`,
      safe: true,
      moderated: false,
      confidence: avgConfidence,
    };
  } catch (error) {
    console.error("Error moderating video:", error);
    return {
      response:
        "🤖 I couldn't fully analyze this video, so I'm being cautious. Please ensure all videos are child-appropriate.",
      safe: false,
      moderated: true,
      confidence: 0.6,
    };
  }
}

/* =========================
   AUDIO MODERATION (U17)
   ========================= */

async function transcribeAudio(filePath) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      // If this model name fails in your env, switch to the
      // one recommended in the OpenAI docs for transcription.
      model: "gpt-4o-mini-transcribe",
    });

    // Different SDK versions shape the response slightly differently
    const text =
      transcription.text ||
      transcription.data?.text ||
      transcription.results?.[0]?.alternatives?.[0]?.transcript ||
      "";

    return text.trim();
  } catch (error) {
    console.error("Error transcribing audio:", error);
    return "";
  }
}

async function moderateAudioAdvanced(filePath, filename) {
  try {
    const transcript = await transcribeAudio(filePath);

    if (!transcript) {
      return {
        response:
          "🤖 I couldn't clearly understand the audio. Please try again with clearer speech or a different file.",
        moderated: false,
        safe: true,
        confidence: 0.4,
      };
    }

    const prefixed = `Audio file: "${filename}". Transcript:\n\n${transcript}`;

    const analysis = await moderateTextAdvanced(prefixed, "audio_demo");

    return {
      response:
        analysis.response +
        "\n\n🎧 (Decision based on the speech-to-text transcript of your audio.)",
      moderated: analysis.moderated,
      safe: analysis.safe,
      confidence: analysis.confidence,
    };
  } catch (error) {
    console.error("Error in advanced audio moderation:", error);
    return {
      response:
        "🤖 I ran into an error while analysing the audio. Please try again later.",
      moderated: false,
      safe: true,
      confidence: 0.5,
    };
  }
}

/* =========================
   URL ANALYSIS (same as before)
   ========================= */
async function analyzeURLAdvanced(url) {
  try {
    const safeDomains = [
      "google.com",
      "youtube.com",
      "wikipedia.org",
      "khanacademy.org",
      "scratch.mit.edu",
      "minecraft.net",
      "roblox.com",
      "coolmath-games.com",
      "nationalgeographic.com",
      "nasa.gov",
      "smithsonianmag.com",
      "kids.gov",
      "pbskids.org",
      "funbrain.com",
      "abcya.com",
    ];

    const lowercaseUrl = url.toLowerCase();

    for (const safeDomain of safeDomains) {
      if (lowercaseUrl.includes(safeDomain)) {
        return {
          safe: true,
          response: `✅ SAFE DOMAIN: ${safeDomain} is a trusted, child-friendly website!`,
          confidence: 0.95,
        };
      }
    }

    const blockedDomains = [
      "pornhub.com",
      "xvideos.com",
      "xnxx.com",
      "redtube.com",
      "youporn.com",
      "onlyfans.com",
      "chaturbate.com",
      "liveleak.com",
      "bestgore.com",
      "4chan.org",
      "8chan.org",
      "kiwifarms.com",
      "casino.com",
      "bet365.com",
    ];

    const suspiciousKeywords = [
      "xxx",
      "adult",
      "porn",
      "sex",
      "nude",
      "gore",
      "violence",
      "casino",
      "bet",
      "gamble",
      "drugs",
      "darkweb",
      "hack",
      "crack",
    ];

    for (const domain of blockedDomains) {
      if (lowercaseUrl.includes(domain)) {
        return {
          safe: false,
          response: `🛡️ BLOCKED: This website (${domain}) is not appropriate for children. Please stick to kid-friendly sites!`,
          confidence: 0.95,
        };
      }
    }

    for (const keyword of suspiciousKeywords) {
      if (lowercaseUrl.includes(keyword)) {
        return {
          safe: false,
          response: `🛡️ BLOCKED: This link contains inappropriate content (${keyword}). Let's keep things child-friendly!`,
          confidence: 0.8,
        };
      }
    }

    return {
      safe: true,
      response:
        "✅ LINK CHECKED: This website appears to be safe! Always ask a trusted adult before visiting new websites.",
      confidence: 0.7,
    };
  } catch (error) {
    console.error("Error analyzing URL:", error);
    return {
      safe: true,
      response:
        "🤖 I couldn't check this link right now, but remember to always ask an adult before visiting new websites!",
      confidence: 0.5,
    };
  }
}

/* =========================
   ROUTES
   ========================= */

// Serve main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Text moderation endpoint
app.post("/api/moderate", async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    if (sessionId && !demoSessions.has(sessionId)) {
      demoSessions.set(sessionId, {
        messageCount: 0,
        moderatedCount: 0,
        startTime: new Date(),
      });
    }

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = message.match(urlRegex);

    let finalResponse = "";
    let wasModerated = false;
    let confidence = 0.8;

    if (urls && urls.length > 0) {
      globalStats.urlsChecked++;
      for (const url of urls) {
        const urlAnalysis = await analyzeURLAdvanced(url);
        if (!urlAnalysis.safe) {
          finalResponse = urlAnalysis.response;
          wasModerated = true;
          confidence = urlAnalysis.confidence;
          break;
        }
      }
      if (!wasModerated) {
        const textAnalysis = await moderateTextAdvanced(message, "web_demo");
        finalResponse = textAnalysis.response;
        wasModerated = textAnalysis.moderated;
        confidence = textAnalysis.confidence;
      }
    } else {
      const textAnalysis = await moderateTextAdvanced(message, "web_demo");
      finalResponse = textAnalysis.response;
      wasModerated = textAnalysis.moderated;
      confidence = textAnalysis.confidence;
    }

    globalStats.totalMessages++;
    if (wasModerated) globalStats.messagesModerated++;

    if (sessionId && demoSessions.has(sessionId)) {
      const session = demoSessions.get(sessionId);
      session.messageCount++;
      if (wasModerated) session.moderatedCount++;
    }

    const responseTime = Date.now() - startTime;
    globalStats.averageResponseTime = Math.round(
      (globalStats.averageResponseTime + responseTime) / 2
    );

    res.json({
      original_message: message,
      kojo_response: finalResponse,
      was_moderated: wasModerated,
      confidence,
      response_time: responseTime,
      timestamp: new Date(),
      // hint to clients that they should redact user text if moderated
      redacted: wasModerated,
    });
  } catch (error) {
    console.error("Error in moderation:", error);
    res.status(500).json({
      error: "Sorry, Kojo is having trouble right now.",
      kojo_response:
        "🤖 I'm having some technical difficulties! Please try again in a moment.",
      was_moderated: false,
    });
  }
});

// Image upload and moderation endpoint
app.post("/api/moderate-image", upload.single("image"), async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.file)
      return res.status(400).json({ error: "Image file is required" });

    const imageBuffer = fs.readFileSync(req.file.path);
    const analysis = await moderateImageAdvanced(
      imageBuffer,
      req.file.originalname
    );

    // Clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) {}

    globalStats.imagesAnalyzed++;
    if (analysis.moderated) globalStats.messagesModerated++;

    const responseTime = Date.now() - startTime;
    res.json({
      filename: req.file.originalname,
      kojo_response: analysis.response,
      was_moderated: analysis.moderated,
      safe: analysis.safe,
      confidence: analysis.confidence,
      response_time: responseTime,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error moderating image:", error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    res.status(500).json({
      error: "Error analyzing image",
      kojo_response:
        "🤖 I couldn't analyze this image right now. Please try again later!",
      was_moderated: false,
    });
  }
});

// Video upload and moderation endpoint (frame extraction + hard flags)
app.post("/api/moderate-video", upload.single("video"), async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.file)
      return res.status(400).json({ error: "Video file is required" });

    const analysis = await moderateVideoAdvanced(
      req.file.path,
      req.file.originalname
    );

    // Clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      console.error("Could not delete uploaded video:", e);
    }

    globalStats.videosAnalyzed++;
    if (analysis.moderated) globalStats.messagesModerated++;

    const responseTime = Date.now() - startTime;
    res.json({
      filename: req.file.originalname,
      kojo_response: analysis.response,
      was_moderated: analysis.moderated,
      safe: analysis.safe,
      confidence: analysis.confidence,
      response_time: responseTime,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error moderating video:", error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    res.status(500).json({
      error: "Error analyzing video",
      kojo_response:
        "🤖 I couldn't analyze this video right now. Please try again later!",
      was_moderated: false,
    });
  }
});

// Audio upload and moderation endpoint
app.post("/api/moderate-audio", upload.single("audio"), async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.file)
      return res.status(400).json({ error: "Audio file is required" });

    const analysis = await moderateAudioAdvanced(
      req.file.path,
      req.file.originalname
    );

    // Clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) {}

    globalStats.audioAnalyzed++;
    if (analysis.moderated) globalStats.messagesModerated++;

    const responseTime = Date.now() - startTime;
    res.json({
      filename: req.file.originalname,
      kojo_response: analysis.response,
      was_moderated: analysis.moderated,
      safe: analysis.safe,
      confidence: analysis.confidence,
      response_time: responseTime,
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("Error moderating audio:", error);
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {}
    }
    res.status(500).json({
      error: "Error analyzing audio",
      kojo_response:
        "🤖 I couldn't analyze this audio right now. Please try again later!",
      was_moderated: false,
    });
  }
});

// Stats & admin
app.get("/api/stats", (req, res) => {
  res.json({
    global: globalStats,
    demo_sessions: demoSessions.size,
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

app.get("/api/admin/overview", (req, res) => {
  const recentSessions = Array.from(demoSessions.entries())
    .slice(-10)
    .map(([id, data]) => ({
      sessionId: id,
      messageCount: data.messageCount,
      moderatedCount: data.moderatedCount,
      moderationRate:
        data.messageCount > 0
          ? ((data.moderatedCount / data.messageCount) * 100).toFixed(1)
          : 0,
      duration: Math.round((Date.now() - data.startTime.getTime()) / 60000), // minutes
    }));

  res.json({
    globalStats,
    recentSessions,
    systemInfo: {
      nodeVersion: process.version,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    },
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "Kojo Advanced System Online!",
    version: "2.0.0",
    features: [
      "Text Moderation",
      "Image Analysis",
      "Video Frame Analysis",
      "URL Checking",
      "Voice Monitoring (Discord bot)",
      "Real-time Statistics",
      "Progressive Filtering",
    ],
    uptime: process.uptime(),
    timestamp: new Date(),
  });
});

// Optional QR endpoint (only if qrcode is installed)
if (QRCode) {
  app.get("/api/qr", async (req, res) => {
    const url = req.query.url || `http://localhost:${port}`;
    try {
      const png = await QRCode.toBuffer(url, { scale: 6, margin: 1 });
      res.set("Content-Type", "image/png");
      res.send(png);
    } catch (e) {
      console.error("QR error:", e);
      res.status(500).json({ error: "QR generation failed" });
    }
  });
}

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File too large",
        kojo_response:
          "🛡️ This file is too big! Please share smaller images or videos.",
      });
    }
  }
  console.error("Server error:", error);
  res.status(500).json({
    error: "Internal server error",
    kojo_response: "🤖 Something went wrong on my end. Please try again!",
  });
});

// Ensure uploads dir
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Start server
app.listen(port, () => {
  console.log(
    `🌐 Kojo Advanced Web Interface running at http://localhost:${port}`
  );
  console.log(
    `📊 Features: Text + Image + Video Frame Analysis + URL moderation with real-time stats`
  );
  console.log(
    `🎥 Video moderation now extracts and analyzes more frames with stricter rules for under-17.`
  );
});
