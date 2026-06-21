import sys
import json
import wave
import subprocess
import os
from vosk import Model, KaldiRecognizer

audio_path = sys.argv[1]
wav_path = audio_path + ".converted.wav"

subprocess.run(
    ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
    check=True, capture_output=True
)

model = Model("/app/vosk-model")
wf = wave.open(wav_path, "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)

words = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        result = json.loads(rec.Result())
        if "result" in result:
            for w in result["result"]:
                words.append({"word": w["word"], "start": round(w["start"], 2), "end": round(w["end"], 2)})

final_result = json.loads(rec.FinalResult())
if "result" in final_result:
    for w in final_result["result"]:
        words.append({"word": w["word"], "start": round(w["start"], 2), "end": round(w["end"], 2)})

os.remove(wav_path)
print(json.dumps({"words": words}))
