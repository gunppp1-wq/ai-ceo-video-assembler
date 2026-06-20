const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
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

function runFfmpeg(imagePath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${outputPath}"`;
    exec(cmd, { timeout: 50000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`ffmpeg failed: ${error.message} | stderr: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

async function b2Authorize(keyId, applicationKey) {
  const credentials = Buffer.from(`${keyId}:${applicationKey}`).toString("base64");
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!res.ok) throw new Error(`B2 authorize failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function b2GetUploadUrl(apiUrl, authToken, bucketId) {
  const res = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${bucketId}`, {
    headers: { Authorization: authToken }
  });
  if (!res.ok) throw new Error(`B2 get upload URL failed: ${res.status}`);
  return await res.json();
}

async function b2UploadFile(uploadUrl, uploadAuthToken, fileName, filePath, contentType) {
  const fileBuffer = fs.readFileSync(filePath);
  const sha1Hex = crypto.createHash("sha1").update(fileBuffer).digest("hex");

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuthToken,
      "X-Bz-File-Name": encodeURIComponent(fileName),
      "Content-Type": contentType,
      "X-Bz-Content-Sha1": sha1Hex,
      "Content-Length": fileBuffer.length
    },
    body: fileBuffer
  });
  if (!res.ok) throw new Error(`B2 upload failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "ai-ceo-video-assembler is running" });
});

app.post("/assemble", async (req, res) => {
  const { imageUrl, audioUrl, b2KeyId, b2ApplicationKey, b2BucketId, outputFileName } = req.body;

  if (!imageUrl || !audioUrl || !b2KeyId || !b2ApplicationKey || !b2BucketId || !outputFileName) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const jobId = crypto.randomUUID();
  const tmpDir = "/tmp";
  const imagePath = path.join(tmpDir, `${jobId}.jpg`);
  const audioPath = path.join(tmpDir, `${jobId}.mp3`);
  const outputPath = path.join(tmpDir, `${jobId}.mp4`);

  try {
    console.log(`[${jobId}] Downloading image and audio...`);
    await downloadFile(imageUrl, imagePath);
    await downloadFile(audioUrl, audioPath);

    console.log(`[${jobId}] Running ffmpeg...`);
    await runFfmpeg(imagePath, audioPath, outputPath);

    console.log(`[${jobId}] Uploading to B2...`);
    const authData = await b2Authorize(b2KeyId, b2ApplicationKey);
    const uploadUrlData = await b2GetUploadUrl(authData.apiUrl, authData.authorizationToken, b2BucketId);
    const uploadResult = await b2UploadFile(uploadUrlData.uploadUrl, uploadUrlData.authorizationToken, outputFileName, outputPath, "video/mp4");

    console.log(`[${jobId}] Done: ${outputFileName}`);
    res.json({ success: true, fileName: outputFileName, fileId: uploadResult.fileId });
  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    [imagePath, audioPath, outputPath].forEach((p) => {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ai-ceo-video-assembler listening on port ${PORT}`);
});
