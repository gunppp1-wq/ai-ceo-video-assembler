import sys
import json
from faster_whisper import WhisperModel

audio_path = sys.argv[1]

model = WhisperModel("tiny", device="cpu", compute_type="int8")

segments, info = model.transcribe(audio_path, word_timestamps=True)

words = []
for segment in segments:
    for word in segment.words:
        words.append({
            "word": word.word.strip(),
            "start": round(word.start, 2),
            "end": round(word.end, 2)
        })

print(json.dumps({"words": words}))
