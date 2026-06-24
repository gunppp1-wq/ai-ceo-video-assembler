const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();
app.use(express.json({ limit: "20mb" }));

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", reject);
  });
}

function runCommand(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${error.message} | stderr: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`, (error, stdout) => {
      if (error) {
        reject(new Error(`ffprobe failed: ${error.message}`));
        return;
      }
      resolve(parseFloat(stdout.trim()));
    });
  });
}

function formatAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;
}

function buildAssFromWords(words, maxWordsPerLine = 3, pauseThreshold = 0.4) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginV
Style: Default,Arial,52,&H0000FFFF,&H00000000,&H80000000,1,4,0,2,580

[Events]
Format: Layer, Start, End, Style, Text
`;

  let events = "";
  if (words.length === 0) {
    return header;
  }

  let chunk = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    const wouldExceedMax = chunk.length >= maxWordsPerLine;
    const hasNaturalPause = gap >= pauseThreshold;

    if (wouldExceedMax || hasNaturalPause) {
      const start = chunk[0].start;
      const end = chunk[chunk.length - 1].end;
      const text = chunk.map(w => w.word).join(" ").replace(/[\\{}]/g, "");
      events += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,${text}\n`;
      chunk = [];
    }
    chunk.push(words[i]);
  }
  if (chunk.length > 0) {
    const start = chunk[0].start;
    const end = chunk[chunk.length - 1].end;
    const text = chunk.map(w => w.word).join(" ").replace(/[\\{}]/g, "");
    events += `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},Default,${text}\n`;
  }

  return header + events;
}

async function transcribeAudio(audioPath) {
  const stdout = await runCommand(`python3 transcribe.py "${audioPath}"`, 60000);
  const result = JSON.parse(stdout.trim().split("\n").pop());
  return result.words || [];
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ai-ceo-video-assembler is running", version: "4-real-frame-sequences" });
});

app.post("/analyze-extract", async (req, res) => {
  const { videoUrl, b2KeyId, b2ApplicationKey, b2BucketId } = req.body;

  if (!videoUrl || !b2KeyId || !b2ApplicationKey || !b2BucketId) {
    return res.status(400).json({ error: "Missing required fields: videoUrl, b2KeyId, b2ApplicationKey, b2BucketId" });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = "/tmp";
  const videoPath = path.join(tmpDir, `${jobId}_input.mp4`);
  const audioPath = path.join(tmpDir, `${jobId}_audio.mp3`);
  const frameDir = path.join(tmpDir, `${jobId}_frames`);

  try {
    console.log(`[${jobId}] Step 1: Downloading video for analysis...`);
    await downloadFile(videoUrl, videoPath);

    console.log(`[${jobId}] Step 2: Extracting audio track...`);
    await runCommand(`ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}"`, 60000);

    console.log(`[${jobId}] Step 3: Extracting frames (1 every 2 seconds)...`);
    fs.mkdirSync(frameDir, { recursive: true });
    await runCommand(`ffmpeg -y -i "${videoPath}" -vf "fps=0.5" "${path.join(frameDir, "frame%d.jpg")}"`, 60000);
    const frameFiles = fs.readdirSync(frameDir).sort();

    console.log(`[${jobId}] Step 4: Authorizing B2 for upload...`);
    const credentials = Buffer.from(`${b2KeyId}:${b2ApplicationKey}`).toString("base64");
    const authRes = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: { Authorization: `Basic ${credentials}` }
    });
    if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status} ${await authRes.text()}`);
    const authData = await authRes.json();
    const apiUrl = authData.apiInfo.storageApi.apiUrl;

    async function uploadToB2(localPath, remoteFileName, contentType) {
      const uploadUrlRes = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${b2BucketId}`, {
        headers: { Authorization: authData.authorizationToken }
      });
      const uploadUrlData = await uploadUrlRes.json();
      const fileBuffer = fs.readFileSync(localPath);
      const sha1Hex = crypto.createHash("sha1").update(fileBuffer).digest("hex");
      const uploadRes = await fetch(uploadUrlData.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: uploadUrlData.authorizationToken,
          "X-Bz-File-Name": encodeURIComponent(remoteFileName),
          "Content-Type": contentType,
          "X-Bz-Content-Sha1": sha1Hex,
          "Content-Length": fileBuffer.length
        },
        body: fileBuffer
      });
      if (!uploadRes.ok) throw new Error(`B2 upload failed for ${remoteFileName}: ${uploadRes.status}`);
      const uploadResult = await uploadRes.json();
      return { fileName: remoteFileName, fileId: uploadResult.fileId };
    }

    console.log(`[${jobId}] Step 5: Uploading extracted audio...`);
    const audioFileName = `extracted/${jobId}_audio.mp3`;
    const audioUploadResult = await uploadToB2(audioPath, audioFileName, "audio/mpeg");

    console.log(`[${jobId}] Step 6: Uploading ${frameFiles.length} extracted frames...`);
    const frameResults = [];
    for (const frameFile of frameFiles) {
      const remoteFileName = `extracted/${jobId}_${frameFile}`;
      const result = await uploadToB2(path.join(frameDir, frameFile), remoteFileName, "image/jpeg");
      frameResults.push(result);
    }

    console.log(`[${jobId}] Done: audio + ${frameResults.length} frames uploaded`);
    res.json({ success: true, audio: audioUploadResult, frames: frameResults });
  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      if (fs.existsSync(frameDir)) fs.rmSync(frameDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.log("Cleanup error (non-fatal):", cleanupErr.message);
    }
  }
});

app.post("/assemble-frames", async (req, res) => {
  const { sceneFrameUrls, sceneVideoUrls, audioUrl, b2KeyId, b2ApplicationKey, b2BucketId, outputFileName } = req.body;
  const realClipUrls = sceneVideoUrls || [];

  if (!sceneFrameUrls || !Array.isArray(sceneFrameUrls) || sceneFrameUrls.length === 0 || !audioUrl || !b2KeyId || !b2ApplicationKey || !b2BucketId || !outputFileName) {
    return res.status(400).json({ error: "Missing required fields: sceneFrameUrls (array of arrays), audioUrl, b2KeyId, b2ApplicationKey, b2BucketId, outputFileName" });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = "/tmp";
  const audioPath = path.join(tmpDir, `${jobId}.mp3`);
  const outputPath = path.join(tmpDir, `${jobId}.mp4`);
  const sceneClipPaths = [];

  try {
    console.log(`[${jobId}] Step 1: Downloading audio and ${sceneFrameUrls.length} scene frame sequences...`);
    await downloadFile(audioUrl, audioPath);

    const sceneDirs = [];
    for (let sceneIdx = 0; sceneIdx < sceneFrameUrls.length; sceneIdx++) {
      const sceneDir = path.join(tmpDir, `${jobId}_scene${sceneIdx}`);
      fs.mkdirSync(sceneDir, { recursive: true });
      sceneDirs.push(sceneDir);

      const frameUrls = sceneFrameUrls[sceneIdx];
      await Promise.all(frameUrls.map((url, i) =>
        downloadFile(url, path.join(sceneDir, `frame${i}.jpg`))
      ));
      console.log(`[${jobId}] Downloaded ${frameUrls.length} frames for scene ${sceneIdx}`);
    }

    console.log(`[${jobId}] Step 2: Getting audio duration...`);
    const audioDuration = await getAudioDuration(audioPath);
    const durationPerScene = Math.min(audioDuration, 60) / sceneFrameUrls.length;
    console.log(`[${jobId}] Audio duration: ${audioDuration}s, ${durationPerScene}s per scene`);

    console.log(`[${jobId}] Step 3: Transcribing audio for captions...`);
    let words = [];
    try {
      words = await transcribeAudio(audioPath);
      console.log(`[${jobId}] Transcribed ${words.length} words`);
    } catch (transcribeErr) {
      console.log(`[${jobId}] WARNING: Transcription failed, proceeding without captions:`, transcribeErr.message);
    }

    const assContent = buildAssFromWords(words);
    fs.writeFileSync(path.join(tmpDir, "captions.ass"), assContent);

    console.log(`[${jobId}] Step 4: Building each scene clip (real video where available, frame sequence otherwise)...`);
    const rawClipPaths = [];
    for (let sceneIdx = 0; sceneIdx < sceneDirs.length; sceneIdx++) {
      const clipPath = path.join(tmpDir, `${jobId}_clip${sceneIdx}.mp4`);
      const realVideoUrl = realClipUrls[sceneIdx];

      if (realVideoUrl) {
        const rawClipPath = path.join(tmpDir, `${jobId}_raw${sceneIdx}.mp4`);
        rawClipPaths.push(rawClipPath);
        console.log(`[${jobId}] Scene ${sceneIdx}: downloading real clip from Pexels...`);
        await downloadFile(realVideoUrl, rawClipPath);

        const cmd = `ffmpeg -y -i "${rawClipPath}" -t ${durationPerScene} -vf "fps=25,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" -an -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${clipPath}"`;
        try {
          await runCommand(cmd, 60000);
          sceneClipPaths.push(clipPath);
          console.log(`[${jobId}] Scene ${sceneIdx} real-clip motion created (${durationPerScene.toFixed(2)}s)`);
          continue;
        } catch (realClipErr) {
          console.log(`[${jobId}] WARNING: real clip failed for scene ${sceneIdx}, falling back to frame sequence:`, realClipErr.message);
        }
      }

      const numFrames = sceneFrameUrls[sceneIdx].length;
      const sourceFps = numFrames / durationPerScene;
      const cmd = `ffmpeg -y -framerate ${sourceFps} -i "${sceneDirs[sceneIdx]}/frame%d.jpg" -t ${durationPerScene} -vf "fps=25,scale=1080:1920" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${clipPath}"`;
      await runCommand(cmd, 60000);
      sceneClipPaths.push(clipPath);
      console.log(`[${jobId}] Scene ${sceneIdx} frame-sequence clip created (${durationPerScene.toFixed(2)}s)`);
    }

    console.log(`[${jobId}] Step 5: Concatenating scene clips, adding captions and audio...`);
    const concatListPath = path.join(tmpDir, `${jobId}_concat.txt`);
    fs.writeFileSync(concatListPath, sceneClipPaths.map(p => `file '${p}'`).join("\n"));

    const concatenatedPath = path.join(tmpDir, `${jobId}_concatenated.mp4`);
    await runCommand(`ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatenatedPath}"`, 30000);

    const finalCmd = `cd ${tmpDir} && ffmpeg -y -i "${concatenatedPath}" -i "${audioPath}" -vf "ass=captions.ass" -map 0:v -map 1:a -c:v libx264 -preset ultrafast -c:a aac -b:a 96k -shortest -t ${Math.min(audioDuration, 60)} "${outputPath}"`;
    await runCommand(finalCmd, 120000);

    console.log(`[${jobId}] Step 6: ffmpeg done. Output size: ${fs.statSync(outputPath).size}`);

    console.log(`[${jobId}] Step 7: Authorizing B2...`);
    const credentials = Buffer.from(`${b2KeyId}:${b2ApplicationKey}`).toString("base64");
    const authRes = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: { Authorization: `Basic ${credentials}` }
    });
    if (!authRes.ok) throw new Error(`B2 authorize failed: ${authRes.status} ${await authRes.text()}`);
    const authData = await authRes.json();
    const apiUrl = authData.apiInfo.storageApi.apiUrl;

    console.log(`[${jobId}] Step 8: Getting upload URL...`);
    const uploadUrlRes = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${b2BucketId}`, {
      headers: { Authorization: authData.authorizationToken }
    });
    if (!uploadUrlRes.ok) throw new Error(`B2 get upload URL failed: ${uploadUrlRes.status}`);
    const uploadUrlData = await uploadUrlRes.json();

    console.log(`[${jobId}] Step 9: Uploading final video to B2...`);
    const fileBuffer = fs.readFileSync(outputPath);
    const sha1Hex = crypto.createHash("sha1").update(fileBuffer).digest("hex");

    const uploadRes = await fetch(uploadUrlData.uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadUrlData.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(outputFileName),
        "Content-Type": "video/mp4",
        "X-Bz-Content-Sha1": sha1Hex,
        "Content-Length": fileBuffer.length
      },
      body: fileBuffer
    });
    if (!uploadRes.ok) throw new Error(`B2 upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
    const uploadResult = await uploadRes.json();

    console.log(`[${jobId}] Done: ${outputFileName}`);
    res.json({ success: true, fileName: outputFileName, fileId: uploadResult.fileId, wordsTranscribed: words.length, scenes: sceneFrameUrls.length });
  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      const cleanupPaths = [audioPath, outputPath, path.join(tmpDir, "captions.ass"), path.join(tmpDir, `${jobId}_concat.txt`), path.join(tmpDir, `${jobId}_concatenated.mp4`)];
      sceneClipPaths.forEach(p => cleanupPaths.push(p));
      rawClipPaths.forEach(p => cleanupPaths.push(p));
      cleanupPaths.forEach((p) => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
      });
      for (let i = 0; i < sceneFrameUrls.length; i++) {
        const sceneDir = path.join(tmpDir, `${jobId}_scene${i}`);
        try { fs.rmSync(sceneDir, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (cleanupErr) {
      console.log("Cleanup error (non-fatal):", cleanupErr.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ai-ceo-video-assembler (v4: real frame sequences) listening on port ${PORT}`);
});










